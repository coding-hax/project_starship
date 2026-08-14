#!/usr/bin/env bash
# Tests für #242: der Runner baut nie im geteilten Haupt-Checkout -- jeder
# Bau-Lauf bekommt einen eigenen Worktree als cwd (Vorfall #196: eine ganze
# Ticket-Arbeit landete unter einem fremden PR, weil der Checkout mitten im
# Lauf die Branch wechselte -- siehe auch #156/#180).
#
# Anders als die übrigen Suiten unter scripts/tests/ wird 'git' hier NICHT
# gestubbt: genau das Verhalten von 'git worktree' ist der Prüfgegenstand.
# Aufbau: ein echtes bare-Repo als 'origin' + ein echter Klon als REPO_DIR,
# ein Commit auf main. 'gh' bleibt gestubbt (ein Roster wie in
# parked-label.test.sh), 'claude' auch (protokolliert nur seinen cwd).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
# Jeder Testblock läuft in einer SUBSHELL -- ein dort gesetztes FAIL=1 erreicht
# diese Shell nie. Deshalb zusätzlich die Flag-Datei (Fehler aus #203).
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; : > "$FAIL_FLAG"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
# Aufgelöst, NICHT der rohe mktemp-Pfad: auf macOS liegt /tmp hinter einem
# Symlink auf /private/tmp -- ein claude-Stub, der `pwd -P` protokolliert,
# würde sonst nie zum unaufgelösten $REPO_DIR passen (dieselbe Falle wie in
# shim-start-path.test.sh B2, #251).
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT
FAIL_FLAG="$TMP/failed"

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' ---------------------------------------------------------------
# Ein Roster ($GHSTATE_DIR/issues.json) wie in parked-label.test.sh, plus die
# beiden für diese Suite zusätzlich gebrauchten Formen: 'issue view --json
# state' (AK5, reopen-Wächter) und 'pr list' (immer leer -- kein PR existiert
# für diese Test-Tickets, hält den echten cli.ts-Pfad einfach).
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
DB="$G/issues.json"
[ -f "$DB" ] || echo '[]' > "$DB"

case "${1:-} ${2:-}" in
  "issue list")
    shift 2
    label=""; q=""; state_filter=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        --state) state_filter="$2"; shift 2 ;;
        --json|--limit) shift 2 ;;
        *) shift ;;
      esac
    done
    data=$(cat "$DB")
    if [ -n "$state_filter" ] && [ "$state_filter" != "all" ]; then
      upper=$(printf '%s' "$state_filter" | tr '[:lower:]' '[:upper:]')
      data=$(printf '%s' "$data" | jq -c --arg s "$upper" '[.[] | select((.state // "OPEN") == $s)]')
    fi
    if [ -n "$label" ]; then
      data=$(printf '%s' "$data" | jq -c --arg l "$label" '[.[] | select(.labels | map(.name) | index($l))]')
    fi
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label)
          add="$2"
          tmp=$(jq --arg n "$issue" --arg l "$add" \
            'map(if (.number|tostring) == $n
                 then .labels |= (map(select(.name != $l)) + [{"name":$l}])
                 else . end)' "$DB")
          printf '%s' "$tmp" > "$DB"
          shift 2 ;;
        --remove-label)
          rem="$2"
          tmp=$(jq --arg n "$issue" --arg l "$rem" \
            'map(if (.number|tostring) == $n
                 then .labels |= map(select(.name != $l))
                 else . end)' "$DB")
          printf '%s' "$tmp" > "$DB"
          shift 2 ;;
        --title)
          printf '%s\n' "$2" >> "$G/status-title-log"
          shift 2 ;;
        --body)
          printf '%s\n===\n' "$2" >> "$G/status-body-log"
          shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  "issue view")
    issue="$3"; shift 3
    json=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    obj=$(jq -c --arg n "$issue" '[.[] | select((.number|tostring) == $n)] | .[0] // {}' "$DB")
    if [ "$json" = "comments" ]; then
      data='{"comments":[]}'
    elif [ "$json" = "state" ]; then
      data=$(printf '%s' "$obj" | jq -c '{state: (.state // "OPEN")}')
    else
      data=$(printf '%s' "$obj" | jq -c '{labels: (.labels // [])}')
    fi
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
    ;;
  "issue comment")
    issue="$3"; shift 3
    body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        --edit-last) shift ;;
        *) shift ;;
      esac
    done
    printf '%s' "$body" > "$G/lastcomment-$issue"
    ;;
  "pr list")
    printf '[]'
    ;;
  *) : ;;
esac
exit 0
STUB

# --- Stub 'claude' -------------------------------------------------------------
# Protokolliert nur, WOHER er aufgerufen wurde -- das ist der Prüfgegenstand
# dieser Suite. Legt selbst nichts im Arbeitsbaum an, tut also nicht so, als
# hätte der Agent Fortschritt gemacht (branchTip bleibt vor/nach gleich).
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
echo x >> "$G/claude-calls"
n=$(wc -l < "$G/claude-calls" | tr -d ' ')
pwd -P > "$G/claude-cwd-$n"
# Verzeichnisinhalt WAEHREND des Laufs -- fuer #325 der einzige Zeitpunkt, an
# dem ein Wegwerf-Worktree ueberhaupt noch existiert (run_round entfernt ihn
# sofort danach).
ls -1 > "$G/claude-listing-$n" 2>/dev/null
printf '%s' '{"session_id":"stub-session","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/claude"
# 'git' bleibt absichtlich UNGESTUBBT -- echtes PATH-git, s.o.
export PATH="$FAKEBIN:$PATH"

# --- Echtes Repo: bare 'origin' + Klon als REPO_DIR ---------------------------
ORIGIN="$TMP/origin.git"
git init --bare -q "$ORIGIN"
# HEAD des bare-Repos explizit auf 'main' -- unabhaengig von init.defaultBranch
# der Laufumgebung. Ohne das zeigt HEAD auf CI-Runnern teils auf 'master'
# (nie erzeugt), und ein SPAETERER Klon (AK7, Zeile ~300) bricht mit "remote
# HEAD refers to nonexistent ref" ab -- kein lokaler Branch, Push scheitert.
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

export REPO_DIR="$TMP/repo"
export SHARED_DIR="$TMP/shared"
git clone -q "$ORIGIN" "$REPO_DIR"
git -C "$REPO_DIR" symbolic-ref HEAD refs/heads/main
git -C "$REPO_DIR" config user.email "test@example.com"
git -C "$REPO_DIR" config user.name "Test"
echo init > "$REPO_DIR/README.md"
# Wie im echten Repo (#226 für .claude/worktrees/, seit je für .runner/):
# beide gitignored, sonst zeigte 'git status' im Haupt-Checkout einen Eintrag
# für jeden angelegten Worktree bzw. für den Runner-Zustand.
printf '.claude/\n.runner/\n' > "$REPO_DIR/.gitignore"
git -C "$REPO_DIR" add README.md .gitignore
git -C "$REPO_DIR" commit -q -m init
git -C "$REPO_DIR" push -q -u origin main

export STATUS_ISSUE=555
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

WT999="$REPO_DIR/.claude/worktrees/issue-999"

reset_gh() {
  rm -rf "$GHSTATE_DIR"
  mkdir -p "$GHSTATE_DIR"
  echo '[]' > "$GHSTATE_DIR/issues.json"
}

seed_issue() {   # $1 = Nr, $2 = "label1,label2", $3 = state (Default OPEN)
  local n="$1" labels="$2" state="${3:-OPEN}" labels_json tmp
  labels_json=$(printf '%s' "$labels" | tr ',' '\n' | jq -R '{name: .}' | jq -s -c '.')
  tmp=$(jq --argjson n "$n" --argjson l "$labels_json" --arg s "$state" \
    '. + [{number:$n, labels:$l, createdAt:"2024-01-01T00:00:00Z", state:$s}]' \
    "$GHSTATE_DIR/issues.json")
  printf '%s' "$tmp" > "$GHSTATE_DIR/issues.json"
}

set_issue_state() {   # $1 = Nr, $2 = neuer state
  local n="$1" s="$2" tmp
  tmp=$(jq --argjson n "$n" --arg s "$s" \
    'map(if (.number|tostring) == ($n|tostring) then .state = $s else . end)' \
    "$GHSTATE_DIR/issues.json")
  printf '%s' "$tmp" > "$GHSTATE_DIR/issues.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

call_count() {
  [ -f "$GHSTATE_DIR/claude-calls" ] && wc -l < "$GHSTATE_DIR/claude-calls" | tr -d ' ' || echo 0
}

cwd_of_call() {   # $1 = Aufrufnummer (1-basiert)
  cat "$GHSTATE_DIR/claude-cwd-$1" 2>/dev/null || echo ""
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then ok "$1"; else red "$1 (erwartet '$2', bekommen '$3')"; fi
}

assert_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = erwarteter Substring
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then ok "$1"
  else red "$1 (Substring '$3' fehlt in $2)"; fi
}

worktree_count() {   # $1 = Pfad -> Anzahl registrierter Einträge fuer genau diesen Pfad
  git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null \
    | grep -cFx "worktree $1"
}

# ==============================================================================
# 1+2. Ready-Ticket #999 -> eine Runde. cwd von claude == der Ticket-Worktree
#      (AK1), dessen Name die Ticketnummer trägt (AK2). Der Haupt-Checkout
#      bleibt dabei auf seiner Branch, unverändert (AK6).
# ==============================================================================
reset_gh
seed_issue 999 "ready"
run_main
assert_eq "AK1/AK2: claude lief im Ticket-Worktree issue-999" "$WT999" "$(cwd_of_call 1)"
assert_eq "AK1: genau EIN Bau-Lauf fand statt" "1" "$(call_count)"
assert_eq "AK6: Haupt-Checkout bleibt auf main" "main" "$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
assert_eq "AK6: Haupt-Checkout ist sauber (kein Statuseintrag)" "" "$(git -C "$REPO_DIR" status --porcelain)"

# ==============================================================================
# 3. Fortsetzung: das Ticket bleibt nach Runde 1 'in-progress' (kein PR, kein
#    Merge). Eine zweite, unabhängige Runner-Runde muss denselben Worktree
#    wiederverwenden statt einen zweiten anzulegen.
# ==============================================================================
run_main
assert_eq "AK3: Runde 2 lief im selben Worktree" "$WT999" "$(cwd_of_call 2)"
assert_eq "AK3: genau EIN registrierter Worktree für #999" "1" "$(worktree_count "$WT999")"

# ==============================================================================
# 4. Ein belegter, nicht registrierter Pfad -- der Lauf bricht ab statt in den
#    Haupt-Checkout auszuweichen. Die Fremddatei bleibt unangetastet.
# ==============================================================================
WT888="$REPO_DIR/.claude/worktrees/issue-888"
mkdir -p "$WT888"
echo "fremd" > "$WT888/foreign.txt"
# Frisches Roster: #999 (aus Fall 1-3 weiterhin 'in-progress') soll die
# Ticketwahl hier nicht vor #888 stellen -- dessen Worktree bleibt als
# physischer Pfad trotzdem bestehen, unabhängig vom Roster.
reset_gh
seed_issue 888 "ready"
BEFORE_CALLS=$(call_count)
run_main
assert_eq "AK4: kein claude-Aufruf für das blockierte Ticket #888" "$BEFORE_CALLS" "$(call_count)"
assert_eq "AK4: die Fremddatei im belegten Pfad bleibt unangetastet" "fremd" "$(cat "$WT888/foreign.txt")"
assert_eq "AK4: Haupt-Checkout bleibt unverändert" "" "$(git -C "$REPO_DIR" status --porcelain)"
assert_contains "AK4: klare Fehlermeldung im Status" "$GHSTATE_DIR/status-body-log" "Worktree für #888"

# ==============================================================================
# 5. Ist ein Ticket zu (Auto-Merge schließt via 'Closes #n'), räumt der nächste
#    Takt dessen Worktree weg -- geöffnete/geparkte behalten ihren.
# ==============================================================================
reset_gh
seed_issue 999 "in-progress" CLOSED
run_main
assert_eq "AK5: der Worktree von #999 ist nach dem Schließen entfernt" "0" "$(worktree_count "$WT999")"
if [ -d "$WT999" ]; then red "AK5: das Verzeichnis von #999 existiert noch"
else ok "AK5: das Verzeichnis von #999 wurde entfernt"; fi

# ==============================================================================
# 6. #325 (O2): Lese-Rollen (plan/research) bekommen ebenfalls einen eigenen
#    Worktree -- aber einen WEGWERF-Worktree, IMMER frisch ab origin/main statt
#    wiederverwendet wie bei der Bau-Rolle. Nachweis der Frische: origin bekommt
#    ausserhalb von REPO_DIR (per Zweitklon) einen neuen Commit, den REPO_DIR
#    selbst nie zieht -- der Lese-Lauf sieht ihn trotzdem, weil sein Worktree
#    selbst fetcht + auf origin/main auscheckt. Danach ist der Worktree wieder
#    weg (kein Wiederverwendungs-Pfad wie bei ensure_worktree).
# ==============================================================================
OTHER="$TMP/other-clone"
git clone -q "$ORIGIN" "$OTHER"
echo marker > "$OTHER/fresh-marker.txt"
git -C "$OTHER" add fresh-marker.txt
git -C "$OTHER" -c user.email=test@example.com -c user.name=Test commit -q -m "fresh marker"
git -C "$OTHER" push -q origin main

reset_gh
seed_issue 700 "plan"
run_main
N=$(call_count)
WT700="$REPO_DIR/.claude/worktrees/readonly-700"

assert_contains "AK7/#325: Lese-Lauf sieht einen frischen origin/main-Commit, den REPO_DIR nie gezogen hat" \
  "$GHSTATE_DIR/claude-listing-$N" "fresh-marker.txt"
assert_eq "AK7/#325: REPO_DIR (Haupt-Checkout) hat den frischen Commit NICHT" \
  "0" "$([ -f "$REPO_DIR/fresh-marker.txt" ] && echo 1 || echo 0)"
assert_eq "AK7/#325: der Wegwerf-Worktree ist nach dem Lauf entfernt" "0" "$(worktree_count "$WT700")"
if [ -d "$WT700" ]; then red "AK7/#325: das Verzeichnis readonly-700 existiert noch"
else ok "AK7/#325: das Verzeichnis readonly-700 wurde entfernt"; fi
assert_eq "AK7/#325: Haupt-Checkout bleibt unveraendert (Lese-Rolle liest nie dort)" "" "$(git -C "$REPO_DIR" status --porcelain)"

# ==============================================================================
echo
[ -e "$FAIL_FLAG" ] && FAIL=1
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Worktree-Tests grün."
else
  red "Mindestens ein Worktree-Test ist rot (siehe oben)."
fi
exit $FAIL
