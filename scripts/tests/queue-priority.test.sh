#!/usr/bin/env bash
# Tests für die Prioritäts-Queue als FLACHE Reihenfolge (#109): das Queue-Issue
# (QUEUE_ISSUE) listet '#NN' in Reihenfolge; wer gelistet ist, wird bearbeitet —
# das Label ist für die AUSWAHL egal. Erhalten bleiben: 'needs-input'/'no-opus'
# schließen aus; die ROLLE kommt aus dem Label (needs-plan -> Plan, needs-research
# -> Recherche, sonst bauen); leere Queue -> Fallback auf Label-Reihenfolge.
#
# Bewiesen wird:
#   1. Gelistetes Ticket OHNE 'ready' (kein/anderes Label) wird gebaut.
#   2. Queue-Reihenfolge schlägt createdAt; früher Gelistetes zuerst.
#   3. Gelistetes schlägt ungelistetes 'ready' (Queue vor Fallback).
#   4. Gelistetes 'needs-plan' -> Planlauf (kein in-progress); 'needs-research' analog.
#   5. 'needs-input' schließt ein gelistetes Ticket aus (Fallback greift).
#   6. 'no-opus' schließt ein gelistetes Ticket aus.
#   7. Leere Queue -> Fallback: 'ready' nach ältestem createdAt.
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
# 'issue view <n> --json body' liefert $G/view-<n>.json (Queue-Body).
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
               cat "$G/list-needs-plan.json" 2>/dev/null || echo '[]'
               cat "$G/list-needs-research.json" 2>/dev/null || echo '[]'
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
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  for l in in-progress needs-plan needs-research ready needs-input; do
    printf '[]' > "$GHSTATE_DIR/list-$l.json"
  done
}

# Legt Tickets in den Schnappschuss (Sammel-Eimer list-ready.json; die echten
# Labels stehen im JSON, nicht im Dateinamen).
snapshot() { printf '%s' "$1" > "$GHSTATE_DIR/list-ready.json"; }

queue_body_fixture() {   # $1 = Issue-Nr, $2 = Body
  jq -n --arg b "$2" '{body:$b}' > "$GHSTATE_DIR/view-$1.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

assert_session_exists() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ -s "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (kein session-$2 — falsches Ticket gewählt?)"; fi
}
assert_session_absent() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ ! -e "$STATE_DIR/session-$2" ]; then ok "$1"
  else red "$1 (session-$2 existiert unerwartet)"; fi
}
assert_label_added() {   # $1 = Beschreibung, $2 = Issue-Nr, $3 = Label
  if grep -q "ADD:$3" "$GHSTATE_DIR/applied-$2" 2>/dev/null; then ok "$1"
  else red "$1 (ADD:$3 nicht angewandt — falsche Rolle?)"; fi
}
assert_label_not_added() {   # $1 = Beschreibung, $2 = Issue-Nr, $3 = Label
  if ! grep -q "ADD:$3" "$GHSTATE_DIR/applied-$2" 2>/dev/null; then ok "$1"
  else red "$1 (ADD:$3 unerwartet angewandt)"; fi
}

export QUEUE_ISSUE=1000

# ==============================================================================
# 1. Gelistetes Ticket OHNE 'ready' (kein Label) wird GEBAUT — Label egal.
# ==============================================================================
reset_state
snapshot '[{"number":77,"labels":[],"createdAt":"2024-01-01T00:00:00Z"}]'
queue_body_fixture 1000 '#77'
run_main
assert_session_exists "AC1: gelistetes #77 ohne Label wird gebaut" 77
assert_label_added    "AC1: #77 bekommt in-progress (Bau-Rolle)" 77 in-progress

# ==============================================================================
# 2. Queue-Reihenfolge schlägt createdAt: #10 älter, Queue listet #99 zuerst.
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '#99
#10'
run_main
assert_session_exists "AC2: Queue zieht #99 vor (schlägt älteres createdAt #10)" 99
assert_session_absent "AC2: #10 bleibt unangetastet" 10

# ==============================================================================
# 3. Gelistetes schlägt ungelistetes 'ready' (Queue vor Fallback).
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '#99'
run_main
assert_session_exists "AC3: gelistetes #99 schlägt ungelistetes ready #10" 99
assert_session_absent "AC3: ungelistetes ready #10 wartet" 10

# ==============================================================================
# 4. Rolle aus Label: gelistetes 'needs-plan' -> Planlauf (KEIN in-progress);
#    gelistetes 'needs-research' -> Recherche (KEIN in-progress).
# ==============================================================================
reset_state
snapshot '[{"number":55,"labels":[{"name":"needs-plan"}],"createdAt":"2024-01-01T00:00:00Z"}]'
queue_body_fixture 1000 '#55'
run_main
assert_session_exists  "AC4: gelistetes needs-plan #55 läuft (Planlauf)" 55
assert_label_not_added "AC4: #55 bekommt KEIN in-progress (Denk-Rolle, kein Bau)" 55 in-progress

reset_state
snapshot '[{"number":66,"labels":[{"name":"needs-research"}],"createdAt":"2024-01-01T00:00:00Z"}]'
queue_body_fixture 1000 '#66'
run_main
assert_session_exists  "AC4: gelistetes needs-research #66 läuft (Recherche)" 66
assert_label_not_added "AC4: #66 bekommt KEIN in-progress" 66 in-progress

# ==============================================================================
# 5. 'needs-input' schließt ein gelistetes Ticket aus -> Fallback baut #88.
# ==============================================================================
reset_state
snapshot '[
  {"number":77,"labels":[{"name":"needs-input"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":88,"labels":[{"name":"ready"}],"createdAt":"2024-02-01T00:00:00Z"}
]'
queue_body_fixture 1000 '#77'
run_main
assert_session_absent "AC5: gelistetes, aber needs-input #77 wird NICHT gewählt" 77
assert_session_exists "AC5: Fallback wählt das ready #88" 88

# ==============================================================================
# 6. 'no-opus' schließt ein gelistetes Ticket aus -> Fallback baut #88.
# ==============================================================================
reset_state
snapshot '[
  {"number":77,"labels":[{"name":"no-opus"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":88,"labels":[{"name":"ready"}],"createdAt":"2024-02-01T00:00:00Z"}
]'
queue_body_fixture 1000 '#77'
run_main
assert_session_absent "AC6: gelistetes, aber no-opus #77 wird NICHT gewählt" 77
assert_session_exists "AC6: Fallback wählt das ready #88" 88

# ==============================================================================
# 7. Leere Queue -> Fallback: 'ready' nach ältestem createdAt (#10 vor #99).
# ==============================================================================
reset_state
snapshot '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 ''
run_main
assert_session_exists "AC7: leere Queue -> Fallback wählt älteres createdAt #10" 10
assert_session_absent "AC7: #99 (jünger) bleibt unangetastet" 99

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Flache-Queue-Tests grün."
else
  red "Mindestens ein Flache-Queue-Test ist rot (siehe oben)."
fi
exit $FAIL
