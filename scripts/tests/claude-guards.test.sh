#!/usr/bin/env bash
# Tests für scripts/claude-hooks/pre-bash-guard.mjs, scripts/claude-hooks/stop-guard.sh
# und ihre Verdrahtung in .claude/settings.json (issue #1214).
#
# Fixture: ein Wegwerf-Projekt mit Haupt-Checkout, verknüpftem Worktree,
# nacktem Remote und einem fremden Repo. Der PreToolUse-Wächter führt nichts
# aus, er liest nur die Befehlszeile -- die geprüften Befehle laufen also nie.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
PRE="$REPO_ROOT/scripts/claude-hooks/pre-bash-guard.mjs"
STOP="$REPO_ROOT/scripts/claude-hooks/stop-guard.sh"
SETTINGS="$REPO_ROOT/.claude/settings.json"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)

g() { git -c user.email=t@t -c user.name=t "$@"; }

MAIN="$TMP/projekt"
WT="$TMP/wt-feat"
OTHER="$TMP/fremd"
REMOTE="$TMP/remote.git"

git init -q --bare "$REMOTE"
git init -q -b main "$MAIN"
echo "start" > "$MAIN/README.md"
g -C "$MAIN" add -A && g -C "$MAIN" commit -qm init
g -C "$MAIN" remote add origin "$REMOTE"
g -C "$MAIN" push -q -u origin main
g -C "$MAIN" fetch -q origin
g -C "$MAIN" worktree add -q -b feat/1-probe "$WT" origin/main
g -C "$WT" push -q -u origin feat/1-probe
git init -q -b main "$OTHER"
g -C "$OTHER" commit -q --allow-empty -m init

# --- Hilfen ---------------------------------------------------------------------
run_pre() {   # $1 = Befehlszeile, $2 = cwd, $3 = CLAUDE_PROJECT_DIR (Default $MAIN)
  node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]},cwd:process.argv[2]}))' "$1" "$2" \
    | CLAUDE_PROJECT_DIR="${3:-$MAIN}" node "$PRE" >"$TMP/stdout" 2>"$TMP/stderr"
  RC=$?
  ERR=$(cat "$TMP/stderr")
}
run_stop() {  # $1 = cwd, $2 = stop_hook_active (true|false)
  node -e 'process.stdout.write(JSON.stringify({hook_event_name:"Stop",stop_hook_active:process.argv[2]==="true",cwd:process.argv[1]}))' "$1" "${2:-false}" \
    | bash "$STOP" >"$TMP/stdout" 2>"$TMP/stderr"
  RC=$?
  ERR=$(cat "$TMP/stderr")
}
run_raw() {   # $1 = Skript (pre|stop), $2 = stdin
  if [ "$1" = pre ]; then
    printf '%s' "$2" | CLAUDE_PROJECT_DIR="$MAIN" node "$PRE" >"$TMP/stdout" 2>"$TMP/stderr"
  else
    printf '%s' "$2" | bash "$STOP" >"$TMP/stdout" 2>"$TMP/stderr"
  fi
  RC=$?
  ERR=$(cat "$TMP/stderr")
}

expect_block() {   # $1 = Beschreibung, $2 = Text, der in der Meldung stehen muss
  if [ "$RC" -eq 2 ] && [[ "$ERR" == *"$2"* ]]; then
    ok "$1"
  else
    red "$1 (erwartet exit 2 mit '$2', bekommen exit $RC: $ERR)"
  fi
}
expect_pass() {    # $1 = Beschreibung
  if [ "$RC" -eq 0 ] && [ -z "$ERR" ] && [ ! -s "$TMP/stdout" ]; then
    ok "$1"
  else
    red "$1 (erwartet exit 0 ohne Ausgabe, bekommen exit $RC: $ERR)"
  fi
}

# --- AK1: Verdrahtung -----------------------------------------------------------
if node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks ?? {};
  const cmd = (list, matcher) => (list ?? []).find((e) => e.matcher === matcher)?.hooks?.find((h) => h.type === "command")?.command ?? "";
  const ok =
    cmd(s.PreToolUse, "Bash").includes("scripts/claude-hooks/pre-bash-guard.mjs") &&
    cmd(s.PostToolUse, "Edit|Write|MultiEdit").includes("scripts/claude-hooks/post-edit-checks.sh") &&
    cmd(s.Stop, undefined).includes("scripts/claude-hooks/stop-guard.sh");
  process.exit(ok ? 0 : 1);
' "$SETTINGS" 2>/dev/null; then
  ok "AK1: settings.json trägt PreToolUse(Bash), PostToolUse(Edit|Write|MultiEdit) und Stop"
else
  red "AK1: settings.json trägt PreToolUse(Bash), PostToolUse(Edit|Write|MultiEdit) und Stop"
fi

if [ -f "$PRE" ] && [ -f "$STOP" ] && [ -x "$STOP" ]; then
  ok "AK1: beide Wächter-Skripte existieren"
else
  red "AK1: beide Wächter-Skripte existieren"
fi

# Die eingetragenen Befehle selbst, so wie Claude Code sie per sh aufruft.
command_of() {   # $1 = Ereignis
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks;
    process.stdout.write(s[process.argv[2]][0].hooks[0].command);
  ' "$SETTINGS" "$1"
}
PRE_CMD=$(command_of PreToolUse)
STOP_CMD=$(command_of Stop)
node -e 'process.stdout.write(JSON.stringify({tool_input:{command:"gh issue comment 5 --edit-last -b x"},cwd:process.argv[1]}))' "$WT" \
  | CLAUDE_PROJECT_DIR="$REPO_ROOT" sh -c "$PRE_CMD" 2>"$TMP/stderr"
RC=$?; ERR=$(cat "$TMP/stderr")
expect_block "AK1: der eingetragene PreToolUse-Befehl blockiert" "--edit-last"

echo "neu" > "$WT/neu.txt"
node -e 'process.stdout.write(JSON.stringify({stop_hook_active:false,cwd:process.argv[1]}))' "$WT" \
  | CLAUDE_PROJECT_DIR="$REPO_ROOT" sh -c "$STOP_CMD" 2>"$TMP/stderr"
RC=$?; ERR=$(cat "$TMP/stderr")
expect_block "AK1: der eingetragene Stop-Befehl hält zurück" "neu.txt"
rm "$WT/neu.txt"

printf '{"tool_input":{"command":"gh pr comment 1 --edit-last"},"cwd":"%s"}' "$WT" \
  | CLAUDE_PROJECT_DIR="$TMP/gibt-es-nicht" sh -c "$PRE_CMD" 2>"$TMP/stderr"
RC=$?; ERR=$(cat "$TMP/stderr")
[ "$RC" -eq 0 ] && [ -z "$ERR" ] \
  && ok "AK1/AK7: ohne Wächter-Skript im Projekt bleibt der Befehl still" \
  || red "AK1/AK7: ohne Wächter-Skript im Projekt bleibt der Befehl still (exit $RC: $ERR)"

# --- AK2: --edit-last --------------------------------------------------------------
run_pre "gh issue comment 5 --edit-last --body x" "$WT"
expect_block "AK2: gh issue comment --edit-last wird blockiert und nennt den Ersatz" "gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<datei>"
run_pre "gh pr comment 7 --edit-last -b y" "$WT"
expect_block "AK2: gh pr comment --edit-last wird blockiert" "--edit-last"
run_pre "cd $WT && gh issue comment 5 --edit-last=true" "$MAIN"
expect_block "AK2: auch hinter cd und als --edit-last=…" "--edit-last"
run_pre 'gh issue comment 5 --body "nie --edit-last benutzen"' "$WT"
expect_pass "AK2: --edit-last nur als Text in Anführungszeichen bleibt erlaubt"
run_pre "gh issue comment 5 --body 'nie --edit-last'" "$WT"
expect_pass "AK2: --edit-last in einfachen Anführungszeichen bleibt erlaubt"
run_pre "$(printf "gh issue comment 5 --body-file - <<'EOF'\nnie --edit-last benutzen\nEOF\ngit -C %s status" "$WT")" "$WT"
expect_pass "AK2: --edit-last in einem Heredoc bleibt erlaubt"
run_pre "echo --edit-last" "$WT"
expect_pass "AK2: --edit-last außerhalb von gh … comment bleibt erlaubt"

# --- AK3: Haupt-Checkout ------------------------------------------------------------
for sub in "commit -m x" "push" "checkout -b neu" "switch main" "merge feat/1-probe" "rebase main" "cherry-pick abc" "revert abc"; do
  run_pre "git $sub" "$MAIN"
  expect_block "AK3: git $sub im Haupt-Checkout wird blockiert" "Haupt-Checkout $MAIN"
done
run_pre "cd $MAIN && git commit -m x" "$OTHER"
expect_block "AK3: cd <Haupt-Checkout> && git commit wird blockiert" "git commit"
run_pre "git -C $MAIN push origin feat/1-probe" "$OTHER"
expect_block "AK3: git -C <Haupt-Checkout> push wird blockiert" "git push"
run_pre "env -u STATE_DIR git commit -m x" "$MAIN"
expect_block "AK3: auch mit env-Präfix" "git commit"
run_pre "git status && git commit -am x" "$MAIN"
expect_block "AK3: auch als zweiter Befehl einer Kette" "git commit"

run_pre "git commit -m x" "$WT"
expect_pass "AK3: git commit im verknüpften Worktree bleibt erlaubt"
run_pre "git -C $WT push" "$MAIN"
expect_pass "AK3: git -C <Worktree> push aus dem Haupt-Checkout bleibt erlaubt"
for sub in "fetch origin" "status --short" "log --oneline -3" "diff --stat" "worktree add -b feat/2-x $TMP/wt2 origin/main"; do
  run_pre "git $sub" "$MAIN"
  expect_pass "AK3: git $sub im Haupt-Checkout bleibt erlaubt"
done
run_pre "git commit -m x" "$OTHER"
expect_pass "AK3: git commit in einem fremden Repo bleibt erlaubt"
run_pre "git commit -m 'fix: cd $MAIN && git push'" "$WT"
expect_pass "AK3: Befehlstext in einer Commit-Nachricht zählt nicht"

# --- AK4: pnpm install -----------------------------------------------------------------
for sub in "install" "i" "add left-pad"; do
  run_pre "pnpm $sub" "$WT"
  expect_block "AK4: pnpm $sub aus dem Worktree wird blockiert und nennt --dir" "--dir $MAIN"
done
run_pre "cd $WT && pnpm install --frozen-lockfile" "$MAIN"
expect_block "AK4: cd <Worktree> && pnpm install wird blockiert" "pnpm install"
run_pre "pnpm install --frozen-lockfile --dir $MAIN" "$WT"
expect_pass "AK4: pnpm install --dir <Haupt-Checkout> bleibt erlaubt"
run_pre "pnpm -C $MAIN install" "$WT"
expect_pass "AK4: pnpm -C <Haupt-Checkout> install bleibt erlaubt"
run_pre "pnpm install" "$MAIN"
expect_pass "AK4: pnpm install im Haupt-Checkout bleibt erlaubt"
run_pre "pnpm exec playwright install chromium" "$WT"
expect_pass "AK4: pnpm exec … install ist kein pnpm install"
run_pre "pnpm test" "$WT"
expect_pass "AK4: andere pnpm-Befehle bleiben erlaubt"

# --- AK5: Stop -------------------------------------------------------------------------
run_stop "$WT"
expect_pass "AK5: sauberer, gepushter Worktree darf enden"

echo "neu" > "$WT/neu.txt"
run_stop "$WT"
expect_block "AK5: neue, nicht ignorierte Datei hält den Lauf zurück" "uncommittete"
run_stop "$WT" true
expect_pass "AK5: mit stop_hook_active endet der Lauf ohne zweite Bremse"
rm "$WT/neu.txt"

echo "geändert" >> "$WT/README.md"
run_stop "$WT"
expect_block "AK5: geänderte Datei hält den Lauf zurück" "README.md"
g -C "$WT" commit -qam "lokal"
run_stop "$WT"
expect_block "AK5: Commit ohne Push hält den Lauf zurück" "1 Commit(s) nicht gepusht"
g -C "$WT" push -q
run_stop "$WT"
expect_pass "AK5: nach dem Push darf der Lauf enden"

WT_NEW="$TMP/wt-neu"
g -C "$MAIN" worktree add -q -b fix/3-ohne-upstream "$WT_NEW" origin/main
g -C "$WT_NEW" commit -q --allow-empty -m "noch nirgends"
run_stop "$WT_NEW"
expect_block "AK5: Branch, der noch nie gepusht wurde, hält zurück" "nicht gepusht"

# Vom origin/main abgezweigt, also Upstream origin/main (autoSetupMerge), dann
# ohne -u gepusht: der gleichnamige Remote-Branch zählt, nicht @{u}.
g -C "$WT_NEW" push -q origin fix/3-ohne-upstream
run_stop "$WT_NEW"
expect_pass "AK5: ohne -u gepusht zählt der gleichnamige Remote-Branch"

# --- AK6: nicht betroffen -----------------------------------------------------------------
echo "dreckig" >> "$MAIN/README.md"
run_stop "$MAIN"
expect_pass "AK6: Haupt-Checkout (Chat-Sitzung) bleibt still"
git -C "$MAIN" checkout -q -- README.md

WT_RO="$TMP/readonly-4"
g -C "$MAIN" worktree add -q --detach "$WT_RO" origin/main
echo "x" > "$WT_RO/notiz.html"
run_stop "$WT_RO"
expect_pass "AK6: detached HEAD (Lese-Rolle) bleibt still"

WT_SPIKE="$TMP/wt-spike"
g -C "$MAIN" worktree add -q -b spike/ohne-nummer "$WT_SPIKE" origin/main
echo "x" > "$WT_SPIKE/neu.txt"
run_stop "$WT_SPIKE"
expect_pass "AK6: Branch ohne feat|fix|chore/<nr>- bleibt still"

# --- AK7: fail-open ---------------------------------------------------------------------
for script in pre stop; do
  run_raw "$script" ""
  expect_pass "AK7: $script — leere Eingabe"
  run_raw "$script" "kein json {"
  expect_pass "AK7: $script — kaputte JSON-Eingabe"
done
run_raw pre '{"tool_name":"Bash","tool_input":{}}'
expect_pass "AK7: pre — kein Befehl"
run_pre "git commit -m x" "$TMP/gibt/es/nicht"
expect_pass "AK7: pre — nicht existierendes Verzeichnis"
run_pre "cd \$IRGENDWO && git commit -m x" "$OTHER"
expect_pass "AK7: pre — unbekanntes cd-Ziel"
run_stop "$TMP/gibt/es/nicht"
expect_pass "AK7: stop — nicht existierendes Verzeichnis"
mkdir -p "$TMP/kein-repo"
run_stop "$TMP/kein-repo"
expect_pass "AK7: stop — kein Git-Repo"

# --- AK8: CI ----------------------------------------------------------------------------
if grep -qE '^[[:space:]]*- run: bash scripts/tests/claude-guards\.test\.sh[[:space:]]*$' "$REPO_ROOT/.github/workflows/ci.yml"; then
  ok "AK8: die Suite läuft als eigener Schritt in ci.yml"
else
  red "AK8: die Suite läuft als eigener Schritt in ci.yml"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  echo "Alle Wächter-Tests grün."
else
  echo "Mindestens ein Wächter-Test rot."
fi
exit $FAIL
