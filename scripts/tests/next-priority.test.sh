#!/usr/bin/env bash
# Tests für den Rang als Label (#725, S2 von ADR-0023): das Label `next` ist
# die Prioritäts-Queue -- ein Ticket mit `next` wird bearbeitet, je ältestes
# createdAt, unabhängig vom Rollenlabel. Ersetzt scripts/tests/queue-priority.test.sh
# (QUEUE_ISSUE-Zeilenreihenfolge), die mit dem Queue-Issue (#92) selbst weg ist.
#
# Erhalten bleiben: 'needs-answer'/'hands-off' schließen aus; die ROLLE kommt
# aus dem Label (plan -> Plan, research -> Recherche, sonst bauen); ohne
# `next`-Ticket -> Fallback auf die Label-Kaskade (plan -> research -> ready).
#
# Bewiesen wird:
#   1. Ein Ticket mit `next` (kein/anderes Label) wird gebaut.
#   2. Mehrere `next`-Tickets: das aelteste createdAt gewinnt.
#   3. `next` schlägt ein ungelistetes 'ready' (Rang vor Fallback).
#   4. `next` + 'plan' -> Planlauf (traegt seit #387 in-progress); 'research' analog.
#   5. 'needs-answer' schließt ein `next`-Ticket aus (Fallback greift).
#   6. 'hands-off' schließt ein `next`-Ticket aus.
#   7. Kein `next`-Ticket -> Fallback: 'ready' nach ältestem createdAt.
#   8. Eine 'Nach:'-Zeile im eigenen Ticket-Body blockiert ein `next`-Ticket
#      UND ein einfaches 'ready'-Ticket gleichzeitig (issue #724/#725).
#
# Reine Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard hält
# main() an) und stubbt gh/git/claude per PATH -- analog round-snap.test.sh.
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
# 'issue list' ohne --label baut ROUND_SNAP aus den vier Ticketwahl-Fixtures
# (die JSON bestimmt die Labels, die Datei ist nur der Sammel-Eimer).
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
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
      data=$({ cat "$G/list-in-progress.json" 2>/dev/null || echo '[]'
               cat "$G/list-plan.json" 2>/dev/null || echo '[]'
               cat "$G/list-research.json" 2>/dev/null || echo '[]'
               cat "$G/list-ready.json" 2>/dev/null || echo '[]'; } | jq -s 'add // []')
    fi
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
    ;;
  "issue view")
    issue="$3"; shift 3
    q=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -q) q="$2"; shift 2 ;;
        --json) shift 2 ;;
        *) shift ;;
      esac
    done
    data=$(cat "$G/view-$issue.json" 2>/dev/null || echo '{"labels":[],"comments":[],"body":""}')
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
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
export SHARED_DIR="$TMP/shared"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR/lock.d" "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  for l in in-progress plan research ready needs-answer; do
    printf '[]' > "$GHSTATE_DIR/list-$l.json"
  done
}

# Legt Tickets in den Schnappschuss (Sammel-Eimer list-ready.json; die echten
# Labels stehen im JSON, nicht im Dateinamen).
snapshot() { printf '%s' "$1" > "$GHSTATE_DIR/list-ready.json"; }

run_main() { ( main ) >/dev/null 2>&1; }

assert_session_exists() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ -s "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (kein session-$2 — falsches Ticket gewählt?)"; fi
}
assert_session_absent() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ ! -e "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (session-$2 existiert unerwartet)"; fi
}
# Denk-Rollen (plan/research) schreiben seit #356 (A) unter session-think-<nr>.
assert_think_session_exists() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ -s "$STATE_DIR/session-think-$2" ]; then ok "$1"
  else red "$1 (kein session-think-$2 — falsches Ticket gewählt?)"; fi
}
assert_label_added() {   # $1 = Beschreibung, $2 = Issue-Nr, $3 = Label
  if grep -q "ADD:$3" "$GHSTATE_DIR/applied-$2" 2>/dev/null; then ok "$1"
  else red "$1 (ADD:$3 nicht angewandt — falsche Rolle?)"; fi
}
assert_label_not_added() {   # $1 = Beschreibung, $2 = Issue-Nr, $3 = Label
  if ! grep -q "ADD:$3" "$GHSTATE_DIR/applied-$2" 2>/dev/null; then ok "$1"
  else red "$1 (ADD:$3 unerwartet angewandt)"; fi
}

# ==============================================================================
# 1. Ticket mit 'next' (kein weiteres Label) wird GEBAUT.
# ==============================================================================
reset_state
snapshot '[{"number":77,"labels":[{"name":"next"}],"createdAt":"2024-01-01T00:00:00Z"}]'
run_main
assert_session_exists "AC1: next-Ticket #77 ohne weiteres Label wird gebaut" 77
assert_label_added    "AC1: #77 bekommt in-progress (Bau-Rolle)" 77 in-progress

# ==============================================================================
# 2. Zwei next-Tickets: das aeltere createdAt gewinnt (#10 vor #99).
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"next"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"next"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
run_main
assert_session_exists "AC2: aelteres next-Ticket #10 gewinnt" 10
assert_session_absent "AC2: juengeres next-Ticket #99 bleibt unangetastet" 99

# ==============================================================================
# 3. next schlaegt ein ungelistetes 'ready' -- Rang vor Fallback, unabhaengig
#    vom createdAt.
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"next"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
run_main
assert_session_exists "AC3: next-Ticket #99 schlaegt aelteres ready #10" 99
assert_session_absent "AC3: ready #10 wartet" 10

# ==============================================================================
# 4. Rolle aus Label: next+'plan' -> Planlauf; next+'research' -> Recherche.
#    Seit #387 (AC1) tragen Denk-Rollen waehrend des Laufs ebenfalls
#    in-progress (Sichtbarkeit + haelt den Slot-Claim).
# ==============================================================================
reset_state
snapshot '[{"number":55,"labels":[{"name":"next"},{"name":"plan"}],"createdAt":"2024-01-01T00:00:00Z"}]'
run_main
assert_think_session_exists  "AC4: next+plan #55 laeuft (Planlauf)" 55
assert_label_added "AC4/#387: #55 bekommt in-progress (auch als Denk-Ticket)" 55 in-progress

reset_state
snapshot '[{"number":66,"labels":[{"name":"next"},{"name":"research"}],"createdAt":"2024-01-01T00:00:00Z"}]'
run_main
assert_think_session_exists  "AC4: next+research #66 laeuft (Recherche)" 66
assert_label_added "AC4/#387: #66 bekommt in-progress (auch als Denk-Ticket)" 66 in-progress

# ==============================================================================
# 5. 'needs-answer' schliesst ein next-Ticket aus -> Fallback baut #88.
# ==============================================================================
reset_state
snapshot '[
  {"number":77,"labels":[{"name":"next"},{"name":"needs-answer"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":88,"labels":[{"name":"ready"}],"createdAt":"2024-02-01T00:00:00Z"}
]'
run_main
assert_session_absent "AC5: next+needs-answer #77 wird NICHT gewaehlt" 77
assert_session_exists "AC5: Fallback waehlt das ready #88" 88

# ==============================================================================
# 6. 'hands-off' schliesst ein next-Ticket aus -> Fallback baut #88.
# ==============================================================================
reset_state
snapshot '[
  {"number":77,"labels":[{"name":"next"},{"name":"hands-off"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":88,"labels":[{"name":"ready"}],"createdAt":"2024-02-01T00:00:00Z"}
]'
run_main
assert_session_absent "AC6: next+hands-off #77 wird NICHT gewaehlt" 77
assert_session_exists "AC6: Fallback waehlt das ready #88" 88

# ==============================================================================
# 7. Kein next-Ticket -> Fallback: 'ready' nach aeltestem createdAt (#10 vor #99).
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
run_main
assert_session_exists "AC7: kein next-Ticket -> Fallback waehlt aelteres createdAt #10" 10
assert_session_absent "AC7: #99 (juenger) bleibt unangetastet" 99

# ==============================================================================
# 8. Eine 'Nach:'-Zeile im eigenen Ticket-Body blockiert ein next-Ticket UND
#    ein einfaches ready-Ticket gleichzeitig (issue #724/#725). #10 und #20
#    bleiben offen -> beide Ketten blockieren, #10 selbst ist unblockiert und
#    gewinnt den Fallback (aeltestes createdAt unter den Unblockierten).
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":20,"labels":[{"name":"ready"}],"createdAt":"2024-01-05T00:00:00Z"},
  {"number":30,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z","body":"Nach: #20"},
  {"number":99,"labels":[{"name":"next"}],"createdAt":"2024-01-01T00:00:00Z","body":"Nach: #10"}
]'
run_main
assert_session_absent "AC8: Ticket-Body-Kette blockiert das next-Ticket #99 (nach #10, offen)" 99
assert_session_absent "AC8: Ticket-Body-Kette blockiert #30 (Nach: #20, offen)" 30
assert_session_exists "AC8: einzig unblockiertes #10 wird gebaut" 10
assert_session_absent "AC8: #20 bleibt unangetastet (juenger als #10)" 20

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle next-Label-Tests grün."
else
  red "Mindestens ein next-Label-Test ist rot (siehe oben)."
fi
exit $FAIL
