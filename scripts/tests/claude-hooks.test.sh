#!/usr/bin/env bash
# Tests für scripts/claude-hooks/post-edit-checks.sh, seine Verdrahtung in
# .claude/settings.json und den Skill .claude/skills/e2e-fallen (issue #1208).
#
# Jeder Fall baut ein Wegwerf-Repo unter mktemp und kopiert die ECHTEN Wächter
# hinein -- geprüft wird also gegen genau die Ausgabe, die CI sieht, nicht gegen
# eine Nachbildung. Nur wo es um "welcher Wächter läuft wo" geht, stehen Stubs.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
HOOK="$REPO_ROOT/scripts/claude-hooks/post-edit-checks.sh"
SETTINGS="$REPO_ROOT/.claude/settings.json"
SKILL="$REPO_ROOT/.claude/skills/e2e-fallen/SKILL.md"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)

GUARDS="check-test-integrity.sh check-design-tokens.sh check-sync-invariants.sh check-tenant-isolation.sh check-codemap.sh"

commit_all() {   # $1 = repo, $2 = message
  git -C "$1" add -A
  git -C "$1" -c user.email=t@t -c user.name=t commit -qm "$2"
}

# Ein sauberes Repo mit den echten Wächtern: jeder Wächter ist darin grün.
make_repo() {   # $1 = Verzeichnis
  local d="$1" g
  mkdir -p "$d/scripts" "$d/tests" "$d/src/ui" "$d/src/features" "$d/src/db" "$d/docs/codemap"
  for g in $GUARDS; do cp "$REPO_ROOT/scripts/$g" "$d/scripts/"; done
  printf '# Code-Karte\n\n- `src/` — App\n' > "$d/docs/CODEMAP.md"
  cat > "$d/src/db/schema.ts" <<'EOF'
export const tasks = pgTable(
  'tasks',
  { ...syncColumns, title: text('title') },
  (table) => [tenantPrimaryKey(table)],
);
EOF
  git -C "$d" init -q -b main
  commit_all "$d" init
}

# Stub-Wächter: schreibt seinen Namen ins Log des Repos, bleibt grün.
make_stub_repo() {   # $1 = Verzeichnis
  local d="$1" g
  mkdir -p "$d/scripts" "$d/tests" "$d/src/ui" "$d/src/features" "$d/docs"
  for g in $GUARDS; do
    printf '#!/usr/bin/env bash\necho %s >> "%s/guards.log"\nexit 1\n' "$g" "$d" > "$d/scripts/$g"
  done
  git -C "$d" init -q -b main
}

# Ruft den Hook wie Claude Code: JSON auf stdin, CLAUDE_PROJECT_DIR gesetzt.
# Ergebnis in RC und ERR (stderr); stdout muss immer leer bleiben.
run_hook() {   # $1 = file_path, $2 = CLAUDE_PROJECT_DIR (Default $TMP)
  run_raw "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$1\"}}" "${2:-$TMP}"
}
run_raw() {    # $1 = stdin, $2 = CLAUDE_PROJECT_DIR (Default $TMP)
  local out
  out=$(printf '%s' "$1" | CLAUDE_PROJECT_DIR="${2:-$TMP}" bash "$HOOK" 2>"$TMP/stderr")
  RC=$?
  ERR=$(cat "$TMP/stderr")
  [ -z "$out" ] || ERR="$ERR [stdout: $out]"
}

expect_report() {   # $1 = Beschreibung, $2 = Wächter, $3 = Text, der im Befund stehen muss
  if [ "$RC" -eq 2 ] && [[ "$ERR" == *"$2"* ]] && [[ "$ERR" == *"$3"* ]]; then
    ok "$1"
  else
    red "$1 (erwartet exit 2 mit '$2' und '$3', bekommen exit $RC: $ERR)"
  fi
}

expect_silent() {   # $1 = Beschreibung
  if [ "$RC" -eq 0 ] && [ -z "$ERR" ]; then
    ok "$1"
  else
    red "$1 (erwartet exit 0 ohne Ausgabe, bekommen exit $RC: $ERR)"
  fi
}

# --- AK1: Verdrahtung in .claude/settings.json -------------------------------
if node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const entry = (s.hooks?.PostToolUse ?? []).find((h) => h.matcher === "Edit|Write|MultiEdit");
  const hook = entry?.hooks?.find((h) => h.type === "command");
  process.exit(hook && hook.command.includes("scripts/claude-hooks/post-edit-checks.sh") ? 0 : 1);
' "$SETTINGS" 2>/dev/null; then
  ok "AK1: settings.json registriert den PostToolUse-Hook für Edit|Write|MultiEdit"
else
  red "AK1: settings.json registriert den PostToolUse-Hook für Edit|Write|MultiEdit"
fi

if [ -f "$HOOK" ] && [ -x "$HOOK" ]; then
  ok "AK1: Hook-Skript existiert und ist ausführbar"
else
  red "AK1: Hook-Skript existiert und ist ausführbar ($HOOK)"
fi

# Der Befehl selbst, so wie Claude Code ihn per sh aufruft.
CMD=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(s.hooks.PostToolUse[0].hooks[0].command);
' "$SETTINGS" 2>/dev/null)
R1="$TMP/r1"; make_repo "$R1"
echo "await page.waitForTimeout(500);" > "$R1/tests/a.spec.ts"
printf '{"tool_input":{"file_path":"%s"}}' "$R1/tests/a.spec.ts" \
  | CLAUDE_PROJECT_DIR="$REPO_ROOT" sh -c "$CMD" 2>"$TMP/stderr"
RC=$?; ERR=$(cat "$TMP/stderr")
expect_report "AK1: der eingetragene Befehl meldet einen Befund mit Exit 2" "check-test-integrity.sh" "tests/a.spec.ts:1:"

printf '{"tool_input":{"file_path":"%s"}}' "$R1/tests/a.spec.ts" \
  | CLAUDE_PROJECT_DIR="$TMP/gibt-es-nicht" sh -c "$CMD" 2>"$TMP/stderr"
RC=$?; ERR=$(cat "$TMP/stderr")
expect_silent "AK1/AK7: der Befehl bleibt still, wenn das Projekt kein Hook-Skript hat"

# --- AK2: Spec- und Testdateien --------------------------------------------------
R2="$TMP/r2"; make_repo "$R2"
echo "await page.waitForTimeout(500);" > "$R2/tests/wait.spec.ts"
echo "test.only('nur der', async () => {});" > "$R2/tests/only.spec.ts"
echo "const now = new Date();" > "$R2/tests/clock.spec.ts"
echo "it.skip('aus', () => {});" > "$R2/src/features/list.test.ts"
echo "test('sauber', async () => {});" > "$R2/tests/clean.spec.ts"

run_hook "$R2/tests/wait.spec.ts"
expect_report "AK2: waitForTimeout im Spec -> Exit 2 mit Datei, Zeile, Wächter" "check-test-integrity.sh" "tests/wait.spec.ts:1:"
run_hook "$R2/tests/only.spec.ts"
expect_report "AK2: .only( im Spec -> Exit 2" "check-test-integrity.sh" "tests/only.spec.ts:1:"
run_hook "$R2/tests/clock.spec.ts"
expect_report "AK2: new Date() ohne Argument im Spec -> Exit 2" "check-test-integrity.sh" "tests/clock.spec.ts:1:"
run_hook "$R2/src/features/list.test.ts"
expect_report "AK2: .skip( im Vitest-Test unter src/ -> Exit 2" "check-test-integrity.sh" "src/features/list.test.ts:1:"

# --- AK3: CSS --------------------------------------------------------------------
R3="$TMP/r3"; make_repo "$R3"
printf '.card {\n  font-size: 14px;\n}\n' > "$R3/src/ui/card.css"
run_hook "$R3/src/ui/card.css"
expect_report "AK3: rohe font-size in src/**/*.css -> Exit 2" "check-design-tokens.sh" "src/ui/card.css:2:"

# --- AK4: src-Code -----------------------------------------------------------------
R4="$TMP/r4"; make_repo "$R4"
printf "export function load() {\n  return fetch('/api/sync/push');\n}\n" > "$R4/src/features/list.tsx"
printf "import { requireOwner } from '@/auth/session';\n" > "$R4/src/features/legacy.ts"
mkdir -p "$R4/src/app/api/things"
printf "import { db } from '@/db';\nexport async function GET() { return db; }\n" > "$R4/src/app/api/things/route.ts"

run_hook "$R4/src/features/list.tsx"
expect_report "AK4: direkter /api/-fetch -> Exit 2" "check-sync-invariants.sh" "src/features/list.tsx:2:"
run_hook "$R4/src/features/legacy.ts"
expect_report "AK4: requireOwner -> Exit 2" "check-tenant-isolation.sh" "src/features/legacy.ts:1:"
run_hook "$R4/src/app/api/things/route.ts"
expect_report "AK4: API-Route mit @/db, aber ohne Konto -> Exit 2" "check-tenant-isolation.sh" "src/app/api/things/route.ts"

cat >> "$R4/src/db/schema.ts" <<'EOF'
export const notes = pgTable(
  'notes',
  { ...syncColumns, body: text('body') },
);
EOF
run_hook "$R4/src/db/schema.ts"
expect_report "AK4: schema.ts meldet die Tabelle ohne tenantPrimaryKey" "check-tenant-isolation.sh" "notes"
if [[ "$ERR" == *"legacy.ts"* ]] || [[ "$ERR" == *"list.tsx"* ]] || [[ "$ERR" == *"things/route.ts"* ]]; then
  red "AK4/AK6: schema.ts-Befund zieht keine Funde anderer Dateien mit ($ERR)"
else
  ok "AK4/AK6: schema.ts-Befund zieht keine Funde anderer Dateien mit"
fi

# --- AK5: Code-Karte ---------------------------------------------------------------
R5="$TMP/r5"; make_repo "$R5"
printf -- '- `a.ts` — %s\n' "$(printf 'x%.0s' $(seq 1 220))" >> "$R5/docs/CODEMAP.md"
run_hook "$R5/docs/CODEMAP.md"
expect_report "AK5: zu lange Zeile in docs/CODEMAP.md -> Exit 2 mit allen roten Befunden" "check-codemap.sh" "Zeichen"

R5b="$TMP/r5b"; make_repo "$R5b"
printf -- '- `a.ts` — Liste, siehe #12\n' > "$R5b/docs/codemap/tests.md"
run_hook "$R5b/docs/codemap/tests.md"
expect_report "AK5: Historie-Marker in einer Bereichskarte -> Exit 2" "check-codemap.sh" "Historie-Marker"

# --- AK6: nur die bearbeitete Datei, nur die passenden Wächter --------------------
run_hook "$R2/tests/clean.spec.ts"
expect_silent "AK6: Befunde in anderen Specs bleiben beim Bearbeiten eines sauberen Specs stumm"

run_hook "$R2/tests/only.spec.ts"
if [[ "$ERR" == *"wait.spec.ts"* ]] || [[ "$ERR" == *"clock.spec.ts"* ]]; then
  red "AK6: der Befund nennt nur die bearbeitete Datei ($ERR)"
else
  ok "AK6: der Befund nennt nur die bearbeitete Datei"
fi

# Commit-bezogener Teil: origin/main hat mehr Tests als HEAD -> Wächter rot,
# aber der Befund nennt keine Datei und darf beim Editieren nicht auftauchen.
R6="$TMP/r6"; make_repo "$R6"
printf "test('eins', () => {});\ntest('zwei', () => {});\n" > "$R6/tests/t.spec.ts"
commit_all "$R6" "zwei Tests"
git -C "$R6" update-ref refs/remotes/origin/main HEAD
printf "test('eins', () => {});\n" > "$R6/tests/t.spec.ts"
commit_all "$R6" "ein Test weniger"
if (cd "$R6" && bash scripts/check-test-integrity.sh >/dev/null 2>&1); then
  red "AK6: Vorbedingung — Testanzahl-Teil des Wächters ist im Fixture rot"
else
  ok "AK6: Vorbedingung — Testanzahl-Teil des Wächters ist im Fixture rot"
fi
run_hook "$R6/tests/t.spec.ts"
expect_silent "AK6: gesunkene Testanzahl (commit-bezogen) bleibt beim Editieren stumm"

R7="$TMP/r7"; make_stub_repo "$R7"
guards_for() {   # $1 = relativer Pfad -> aufgerufene Wächter, sortiert, eine Zeile
  rm -f "$R7/guards.log"
  run_hook "$R7/$1"
  [ -f "$R7/guards.log" ] && sort "$R7/guards.log" | tr '\n' ' ' | sed 's/ $//'
}
expect_guards() {   # $1 = relativer Pfad, $2 = erwartete Wächter
  local got; got=$(guards_for "$1")
  if [ "$got" = "$2" ]; then
    ok "AK6: $1 startet nur: ${2:-keinen Wächter}"
  else
    red "AK6: $1 startet nur: ${2:-keinen Wächter} (bekommen: ${got:-keinen})"
  fi
}
expect_guards "src/ui/a.css" "check-design-tokens.sh"
expect_guards "tests/a.spec.ts" "check-test-integrity.sh"
expect_guards "src/features/a.tsx" "check-sync-invariants.sh check-tenant-isolation.sh"
expect_guards "docs/CODEMAP.md" "check-codemap.sh"
expect_guards "tests/helpers.ts" ""
expect_guards "README.md" ""

# --- AK7: fail-open ------------------------------------------------------------------
mkdir -p "$TMP/nogit/tests"
echo "await page.waitForTimeout(500);" > "$TMP/nogit/tests/a.spec.ts"
run_hook "$TMP/nogit/tests/a.spec.ts"
expect_silent "AK7: Datei außerhalb eines Git-Repos"

echo "# Hallo" > "$R2/README.md"
run_hook "$R2/README.md"
expect_silent "AK7: Pfad ohne zugehörigen Wächter"

R8="$TMP/r8"; make_repo "$R8"
rm "$R8/scripts/check-test-integrity.sh"
echo "await page.waitForTimeout(500);" > "$R8/tests/a.spec.ts"
run_hook "$R8/tests/a.spec.ts"
expect_silent "AK7: fehlendes Wächter-Skript"

run_hook "$TMP/gibt/es/nicht/a.spec.ts"
expect_silent "AK7: Datei in einem nicht existierenden Verzeichnis"

run_raw ""
expect_silent "AK7: leere Eingabe"
run_raw "kein json {"
expect_silent "AK7: kaputte JSON-Eingabe"
run_raw '{"tool_name":"Edit","tool_input":{}}'
expect_silent "AK7: JSON ohne file_path"

# --- AK8: Repo der Datei, nicht der Sitzung ----------------------------------------
# Sitzung im Repo A (Stub-Wächter, protokollieren jeden Aufruf), bearbeitet wird in B.
RA="$TMP/ra"; make_stub_repo "$RA"
RB="$TMP/rb"; make_repo "$RB"
echo "await page.waitForTimeout(500);" > "$RB/tests/a.spec.ts"
rm -f "$RA/guards.log"
run_hook "$RB/tests/a.spec.ts" "$RA"
expect_report "AK8: Datei in einem anderen Worktree -> dessen Wächter melden" "check-test-integrity.sh" "tests/a.spec.ts:1:"
if [[ "$ERR" == *"cd $RB "* ]] && [ ! -f "$RA/guards.log" ]; then
  ok "AK8: gelaufen ist im Wurzelverzeichnis von B, kein Wächter aus A"
else
  red "AK8: gelaufen ist im Wurzelverzeichnis von B, kein Wächter aus A (log: $(cat "$RA/guards.log" 2>/dev/null); $ERR)"
fi

run_hook "tests/a.spec.ts" "$RB"
expect_report "AK8: relativer file_path wird gegen CLAUDE_PROJECT_DIR aufgelöst" "check-test-integrity.sh" "tests/a.spec.ts:1:"

# --- AK9: Skill e2e-fallen ------------------------------------------------------------
# Prüft jede Helfer-Angabe `tests/<datei>: <name>` und jeden genannten
# tests/-Pfad gegen den Baum unter $2. Exit 0 = alles gefunden.
check_skill() {   # $1 = SKILL.md, $2 = Repo-Wurzel -> fehlende Angaben auf stdout
  local skill="$1" root="$2" ref file name path missing=0 refs=0
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    refs=$((refs + 1))
    file="${ref%%: *}"
    name="${ref#*: }"
    if [ ! -f "$root/$file" ] || \
       ! grep -qE "(function|const|let|class)[[:space:]]+$name([^A-Za-z0-9_]|\$)" "$root/$file"; then
      echo "fehlt: $file: $name"
      missing=1
    fi
  done < <(grep -oE '`tests/[^`: ]+: [A-Za-z_][A-Za-z0-9_]*`' "$skill" | tr -d '`')
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    [ -f "$root/$path" ] || { echo "fehlt: $path"; missing=1; }
  done < <(grep -oE '`tests/[^`: ]+\.ts`' "$skill" | tr -d '`')
  [ "$refs" -gt 0 ] || { echo "keine Helfer-Angabe gefunden"; missing=1; }
  return $missing
}

if head -1 "$SKILL" 2>/dev/null | grep -qx -- '---' && \
   grep -qx 'name: e2e-fallen' "$SKILL" && \
   grep -qE '^description: .{20,}' "$SKILL"; then
  ok "AK9: SKILL.md hat Frontmatter mit name und description"
else
  red "AK9: SKILL.md hat Frontmatter mit name und description"
fi

if MISSING=$(check_skill "$SKILL" "$REPO_ROOT"); then
  ok "AK9: jeder im Skill genannte Helfer und tests/-Pfad existiert"
else
  red "AK9: jeder im Skill genannte Helfer und tests/-Pfad existiert ($MISSING)"
fi

mkdir -p "$TMP/skill/tests"
printf 'export function realHelper() {}\n' > "$TMP/skill/tests/helpers.ts"
printf -- '- `tests/helpers.ts: realHelper` und `tests/helpers.ts: goneHelper`\n' > "$TMP/skill/SKILL.md"
if check_skill "$TMP/skill/SKILL.md" "$TMP/skill" >/dev/null; then
  red "AK9: die Prüfung schlägt bei einem verschwundenen Helfer an"
else
  ok "AK9: die Prüfung schlägt bei einem verschwundenen Helfer an"
fi

# --- AK10/AK11: Auslöser in CLAUDE.md, Suite in CI ----------------------------------
if grep -E '^\|.*Playwright.*\|.*e2e-fallen' "$REPO_ROOT/CLAUDE.md" >/dev/null; then
  ok "AK10: die Anlass-Tabelle in CLAUDE.md nennt den Skill e2e-fallen"
else
  red "AK10: die Anlass-Tabelle in CLAUDE.md nennt den Skill e2e-fallen"
fi

if grep -qE '^[[:space:]]*- run: bash scripts/tests/claude-hooks\.test\.sh[[:space:]]*$' "$REPO_ROOT/.github/workflows/ci.yml"; then
  ok "AK11: die Suite läuft als eigener Schritt in ci.yml"
else
  red "AK11: die Suite läuft als eigener Schritt in ci.yml"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  echo "Alle Hook- und Skill-Tests grün."
else
  echo "Mindestens ein Hook- oder Skill-Test rot."
fi
exit $FAIL
