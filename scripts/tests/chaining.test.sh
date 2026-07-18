#!/usr/bin/env bash
# Tests für die Ticket-Chaining-Kette (Issue #61): main() ruft run_round() bis
# zu MAX_ROUNDS mal auf, aber NUR solange die vorige Runde sauber gruen war
# (RC=0, keine offene Frage). Reine Bash-Assertions, kein bats (keine neue
# Dependency). Sourct claude-runner.sh (Source-Guard verhindert, dass main()
# dabei loslaeuft) und stubbt gh/git/claude per PATH-Shim in einem
# Wegwerf-Zustandsverzeichnis — analog zu research-mode.test.sh/escalation.test.sh.
#
# Der 'gh'-Stub liest 'issue list --label X' normalerweise aus einer
# ungebundenen Datei list-X.json (wie in den Schwesterdateien). Für die
# Chaining-Tests muss sich der Zustand aber ZWISCHEN Runden ändern können
# (z. B. needs-plan -> ready, so wie es der echte Planer-Lauf am Ende tut).
# Dafür zaehlt der Stub Runden an ROUND_SNAP hoch -- der EINEN, ungelabelten
# 'issue list --json number,labels,createdAt'-Abfrage (#64), die IMMER die
# erste gh-Anfrage in run_round() ist -- und bevorzugt je Label eine
# rundenspezifische Datei list-X-rN.json, falls vorhanden, sonst die
# ungebundene list-X.json. Ein zweiter ungelabelter Aufruf OHNE createdAt
# (queue_snapshot(), fuer die Status-Anzeige) liest dieselbe Runde, zaehlt
# aber NICHT hoch.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' ---------------------------------------------------------------
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

resolve_label_data() {   # $1 = Label, $2 = Runde -> JSON-Array auf stdout
  local label="$1" round="$2" file
  file="$G/list-$label-r$round.json"
  [ -f "$file" ] || file="$G/list-$label.json"
  cat "$file" 2>/dev/null || echo '[]'
}

merged_snapshot() {   # $1 = Runde -> vereinigtes Array ueber alle 4 Ticketwahl-Labels
  local round="$1"
  { resolve_label_data in-progress "$round"
    resolve_label_data needs-plan "$round"
    resolve_label_data needs-research "$round"
    resolve_label_data ready "$round"; } | jq -s 'add // []'
}

case "${1:-} ${2:-}" in
  "issue list")
    shift 2
    label=""; json=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="$2"; shift 2 ;;
        --json) json="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        --state|--limit) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -z "$label" ] && [ "$json" = "number,labels,createdAt" ]; then
      # ROUND_SNAP (#64): die neue Ein-Abfrage-Ticketwahl -- IMMER die erste
      # gh-Anfrage in run_round() -- daran haengt sich der Rundenzaehler.
      round=$(( $(cat "$G/round" 2>/dev/null || echo 0) + 1 ))
      echo "$round" > "$G/round"
      data=$(merged_snapshot "$round")
    elif [ -n "$label" ]; then
      round=$(cat "$G/round" 2>/dev/null || echo 0)
      data=$(resolve_label_data "$label" "$round")
    else
      # queue_snapshot() -- ungelabelt, aber ohne createdAt (Status-Anzeige
      # nach einer Runde). Liest dieselbe Runde, zaehlt aber nicht hoch.
      round=$(cat "$G/round" 2>/dev/null || echo 0)
      data=$(merged_snapshot "$round")
    fi
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
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
    data=$(cat "$G/view-$issue.json" 2>/dev/null || echo '{"labels":[],"comments":[]}')
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label) echo "ADD:$2" >> "$G/applied-$issue"; shift 2 ;;
        --remove-label) echo "REMOVE:$2" >> "$G/applied-$issue"; shift 2 ;;
        --title|--body) shift 2 ;;
        *) shift ;;
      esac
    done
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
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ----------------------------------------------------------------
# 'status --porcelain' fürs Read-only-Netz (sauberer Baum per Default) und
# 'ls-remote --heads origin <muster...>' für branch_tip() (build_escalation_eval).
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
case "${1:-}" in
  status)
    [ -f "$G/dirty-flag" ] && echo " M dirty-file.txt"
    exit 0 ;;
  ls-remote)
    if [ "${2:-}" = "--heads" ]; then
      shift 3   # ls-remote --heads origin
      for pat in "$@"; do
        num=$(echo "$pat" | grep -oE '[0-9]+' | head -1)
        f="$G/tip-$num"
        if [ -s "$f" ]; then
          printf '%s\trefs/heads/%s\n' "$(cat "$f")" "$pat"
          break
        fi
      done
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
STUB

# --- Stub 'claude' -----------------------------------------------------------
# Zaehlt jeden Aufruf mit (macht die Rundenzahl von aussen messbar) und
# verhaelt sich je nach CLAUDE_STUB_MODE: 'success' (Default) liefert sofort
# sauber grün zurück, 'timeout' haengt (fuer die Notbremse, siehe MAX_RUNTIME
# im jeweiligen Testfall), 'hardfail' liefert einen inhaltlichen Fehlschlag.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
echo x >> "$G/claude-calls"
printf '%s\n' "$@" > "$G/claude-lastargs"
case "${CLAUDE_STUB_MODE:-success}" in
  timeout)
    trap 'exit 143' TERM
    sleep 3
    ;;
  hardfail)
    printf '%s' '{"session_id":"stub","result":"boom"}'
    exit 1
    ;;
  *)
    printf '%s' '{"session_id":"stub-session","result":"ok"}'
    exit 0
    ;;
esac
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
}

list_json() {   # $1 = Label, $2 = JSON-Array-Inhalt (roh) -- gilt fuer ALLE Runden
  printf '%s' "$2" > "$GHSTATE_DIR/list-$1.json"
}

list_json_round() {   # $1 = Label, $2 = Runde, $3 = JSON-Array-Inhalt -- nur DIESE Runde
  printf '%s' "$3" > "$GHSTATE_DIR/list-$1-r$2.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

call_count() {
  [ -f "$GHSTATE_DIR/claude-calls" ] && wc -l < "$GHSTATE_DIR/claude-calls" | tr -d ' ' || echo 0
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

assert_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = erwarteter Substring
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then
    ok "$1"
  else
    red "$1 (Substring '$3' fehlt in $2)"
  fi
}

# ==============================================================================
# 1. Kette bricht bei needs-input ab -- ein baubereites Ticket (#70) wird zwar
#    sauber fertig, aber ein ANDERES Ticket (#80) wartet auf den Menschen ->
#    genau 1 claude-Aufruf, obwohl die Queue noch Arbeit haette.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":70,"labels":[{"name":"ready"}]}]'
list_json needs-input '[{"number":80,"labels":[{"name":"needs-input"}]}]'
run_main
assert_eq "AC1: Kette bricht bei needs-input ab (genau 1 claude-Aufruf)" "1" "$(call_count)"

# ==============================================================================
# 2. Rundenobergrenze: ein immer wieder baubereites Ticket haelt die Kette bei
#    MAX_ROUNDS an (Default 3), respektiert aber einen Override.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":90,"labels":[{"name":"ready"}]}]'
list_json needs-input '[]'
run_main
assert_eq "AC2a: MAX_ROUNDS-Default (3) wird eingehalten" "3" "$(call_count)"

reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":90,"labels":[{"name":"ready"}]}]'
list_json needs-input '[]'
MAX_ROUNDS=2
run_main
MAX_ROUNDS=3
assert_eq "AC2b: MAX_ROUNDS=2 wird als Override respektiert" "2" "$(call_count)"

# ==============================================================================
# 3. Chaining nach sauberem Lauf -- der teure needs-plan -> ready-Uebergang
#    (#61 Kernidee): Runde 1 plant #61 (needs-plan), Runde 2 findet es als
#    'ready' und baut es SOFORT im selben Tick.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-input '[]'
list_json_round needs-plan     1 '[{"number":61,"labels":[{"name":"needs-plan"}]}]'
list_json_round needs-research 1 '[]'
list_json_round needs-plan     2 '[]'
list_json_round needs-research 2 '[]'
list_json_round ready          2 '[{"number":61,"labels":[{"name":"ready"}]}]'
run_main
assert_eq "AC3a: needs-plan -> ready lief in genau zwei Runden im selben Tick" "2" "$(call_count)"
assert_contains "AC3b: die zweite Runde hat #61 tatsaechlich gebaut (in-progress gesetzt)" \
  "$GHSTATE_DIR/applied-61" "ADD:in-progress"

# ==============================================================================
# 4. Notbremse bricht die Kette ab -- MAX_RUNTIME wird ueberschritten, keine
#    zweite Runde.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":95,"labels":[{"name":"ready"}]}]'
list_json needs-input '[]'
MAX_RUNTIME=1
CLAUDE_STUB_MODE=timeout
export CLAUDE_STUB_MODE
run_main
unset CLAUDE_STUB_MODE
MAX_RUNTIME=2700
assert_eq "AC4: Notbremse beendet die Kette nach der ersten Runde" "1" "$(call_count)"

# ==============================================================================
# 5. Harter Exit / rotes Gate bricht die Kette ab -- kein Limit, keine
#    Notbremse, einfach ein inhaltlicher Fehlschlag (Exit != 0).
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":96,"labels":[{"name":"ready"}]}]'
list_json needs-input '[]'
CLAUDE_STUB_MODE=hardfail
export CLAUDE_STUB_MODE
run_main
unset CLAUDE_STUB_MODE
assert_eq "AC5: harter Fehlschlag (Exit != 0) beendet die Kette nach der ersten Runde" "1" "$(call_count)"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Chaining-Tests grün."
else
  red "Mindestens ein Chaining-Test ist rot (siehe oben)."
fi
exit $FAIL
