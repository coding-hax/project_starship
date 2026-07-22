#!/usr/bin/env bash
# Tests für #121: ein Tick, dessen 'limit-until' in der Vergangenheit liegt,
# muss die Pause selbst aufheben (kein Warten auf einen Menschen) und wieder
# ein Ticket wählen. Liegt 'limit-until' noch in der Zukunft, bleibt die Pause
# unangetastet. Ein fehlender/unlesbarer Wert pausiert NICHT dauerhaft.
#
# Reine Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard hält
# main() an) und stubbt gh/git/claude per PATH -- analog queue-priority.test.sh.
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
# 'issue list' ohne --label liefert den Sammel-Eimer list-ready.json (ein
# einzelnes 'ready'-Ticket reicht für diese Tests). 'issue edit' protokolliert
# jeden Aufruf, damit Tests beweisen können, dass NACH dem Limit-Check gar
# nichts angefasst wurde (AC3).
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
echo "CALL: $*" >> "$G/calls.log"
case "${1:-} ${2:-}" in
  "issue list")
    shift 2
    label=""; q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) label="$2"; shift 2 ;;
        -q) q="$2"; shift 2 ;;
        --json|--state|--limit) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -n "$label" ]; then
      data=$(cat "$G/list-$label.json" 2>/dev/null || echo '[]')
    else
      data=$(cat "$G/list-ready.json" 2>/dev/null || echo '[]')
    fi
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label) echo "ADD:$2" >> "$G/applied-$issue"; shift 2 ;;
        --remove-label) echo "REMOVE:$2" >> "$G/applied-$issue"; shift 2 ;;
        --title) echo "$2" > "$G/status-title-$issue"; shift 2 ;;
        --body) shift 2 ;;
        *) shift ;;
      esac
    done
    ;;
  *) : ;;
esac
exit 0
STUB

cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s' '{"session_id":"sid-xyz","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=999
export QUEUE_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  printf '[{"number":77,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]' \
    > "$GHSTATE_DIR/list-ready.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

assert_session_exists() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ -s "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (kein session-$2 — Ticket wurde nicht gebaut)"; fi
}
assert_session_absent() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ ! -e "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (session-$2 existiert unerwartet — Pause wurde nicht respektiert)"; fi
}
assert_limit_file_absent() {   # $1 = Beschreibung
  if [ ! -e "$LIMIT_UNTIL" ]; then ok "$1"
  else red "$1 (limit-until liegt noch da)"; fi
}
assert_limit_file_unchanged() {   # $1 = Beschreibung, $2 = erwarteter Inhalt
  if [ "$(cat "$LIMIT_UNTIL" 2>/dev/null)" = "$2" ]; then ok "$1"
  else red "$1 (Inhalt wurde angefasst)"; fi
}
assert_no_ticket_selection() {   # $1 = Beschreibung
  # cleanup_state_dir() liest routinemäßig 'issue list --label in-progress'
  # (nur lesend, 7-Tage-Aufräumen) -- das läuft auch während der Pause und ist
  # kein Verstoß. Was während aktiver Pause NIEMALS passieren darf: der
  # ROUND_SNAP-Aufruf der Ticketwahl ('--limit 100 ... createdAt') oder jede
  # Art von 'issue edit' (Label/Status).
  if grep -qE 'issue list.*--limit 100|issue edit' "$GHSTATE_DIR/calls.log" 2>/dev/null; then
    red "$1 (Ticketwahl/-mutation trotz aktiver Pause: $(tr '\n' ';' < "$GHSTATE_DIR/calls.log"))"
  else
    ok "$1"
  fi
}
assert_status_title_contains() {   # $1 = Beschreibung, $2 = erwarteter Substring
  local title
  title=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  case "$title" in
    *"$2"*) ok "$1" ;;
    *) red "$1 (Titel: '$title')" ;;
  esac
}
assert_status_title_not_contains() {   # $1 = Beschreibung, $2 = unerwarteter Substring
  local title
  title=$(cat "$GHSTATE_DIR/status-title-999" 2>/dev/null || echo "")
  case "$title" in
    *"$2"*) red "$1 (Titel hängt noch am alten Text: '$title')" ;;
    *) ok "$1" ;;
  esac
}

NOW=$(date +%s)

# ==============================================================================
# 1. limit-until in der Vergangenheit -> Pause hebt sich auf, #77 wird gebaut,
#    die Datei verschwindet, der Status wechselt weg von "Limit erreicht".
# ==============================================================================
reset_state
echo $((NOW - 3600)) > "$LIMIT_UNTIL"
run_main
assert_session_exists         "AC1: abgelaufenes limit-until -> #77 wird gebaut" 77
assert_limit_file_absent      "AC1: limit-until wird nach Ablauf aufgeräumt"
assert_status_title_contains     "AC2: Status nennt das bearbeitete Ticket #77" "#77"
assert_status_title_not_contains "AC2: Status hängt NICHT mehr an 'Limit erreicht'" "Limit erreicht"

# ==============================================================================
# 2. limit-until in der Zukunft -> Pause bleibt exakt bestehen, kein gh-Aufruf,
#    kein Ticket wird angefasst.
# ==============================================================================
reset_state
echo $((NOW + 3600)) > "$LIMIT_UNTIL"
run_main
assert_session_absent         "AC3: aktives limit-until -> #77 bleibt unangetastet" 77
assert_limit_file_unchanged   "AC3: limit-until bleibt unverändert stehen" "$((NOW + 3600))"
assert_no_ticket_selection     "AC3: keine Ticketwahl/-mutation während aktiver Pause"

# ==============================================================================
# 3. limit-until fehlt komplett -> läuft normal, #77 wird gebaut.
# ==============================================================================
reset_state
rm -f "$LIMIT_UNTIL"
run_main
assert_session_exists "AC4: fehlendes limit-until pausiert nicht -> #77 wird gebaut" 77

# ==============================================================================
# 4. limit-until unlesbar/kein Zahlwert -> gilt als abgelaufen, läuft normal
#    UND die kaputte Datei wird aufgeräumt (kein Dauer-Hänger).
# ==============================================================================
reset_state
printf 'nicht-ein-zeitstempel' > "$LIMIT_UNTIL"
run_main
assert_session_exists    "AC4: unlesbares limit-until pausiert nicht -> #77 wird gebaut" 77
assert_limit_file_absent "AC4: unlesbares limit-until wird aufgeräumt"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Limit-Until-Tests grün."
else
  red "Mindestens ein Limit-Until-Test ist rot (siehe oben)."
fi
exit $FAIL
