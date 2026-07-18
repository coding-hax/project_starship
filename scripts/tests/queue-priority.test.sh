#!/usr/bin/env bash
# Tests für die Prioritäts-Queue (#91): ein vom Menschen editierbares
# Queue-Issue (QUEUE_ISSUE) bestimmt die REIHENFOLGE innerhalb eines Labels,
# ohne Labels umzuhängen. Sektionen '## Build' (ordnet 'ready'), '## Plan'
# (needs-plan), '## Research' (needs-research).
#
# Bewiesen wird:
#   1. Build ordnet 'ready' — ein gelistetes, jünger erstelltes Ticket schlägt
#      ein älteres (das ohne Queue nach createdAt gewonnen hätte).
#   2/3. Analog Plan (needs-plan) und Research (needs-research).
#   4. Das Label bleibt das Tor — eine Queue-Zeile ohne passendes Label wird
#      NICHT gewählt.
#   5. Nicht Gelistetes rutscht HINTER das Gelistete.
#   6. Kein Queue-Issue (QUEUE_ISSUE=0) -> exakt bisheriges createdAt-Verhalten.
#
# Reine Bash-Assertions, kein bats (keine neue Dependency). Sourct
# claude-runner.sh (Source-Guard hält main() an) und stubbt gh/git/claude per
# PATH -- analog zu round-snap.test.sh. Der gh-Stub liefert zusätzlich den
# Queue-Body über 'issue view <QUEUE_ISSUE> --json body'.
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
# 'issue list' ohne --label baut ROUND_SNAP aus den vier Ticketwahl-Fixtures.
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

# Liefert eine gültige session_id, damit run_round einen Treffer als
# "gearbeitet" verbucht und session-$ISSUE schreibt.
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
  # Default: alle Listen leer, kein needs-input.
  for l in in-progress needs-plan needs-research ready needs-input; do
    printf '[]' > "$GHSTATE_DIR/list-$l.json"
  done
}

list_json() { printf '%s' "$2" > "$GHSTATE_DIR/list-$1.json"; }

# Queue-Issue-Body setzen (QUEUE_ISSUE muss auf diese Nummer zeigen).
queue_body_fixture() {   # $1 = Issue-Nr, $2 = Markdown-Body
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

export QUEUE_ISSUE=1000

# ==============================================================================
# 1. Build ordnet 'ready': #10 ist ÄLTER erstellt (gewönne ohne Queue), die
#    Queue listet aber #99 zuerst -> #99 wird gewählt.
# ==============================================================================
reset_state
list_json ready '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '## Build
#99

## Plan

## Research
'
run_main
assert_session_exists "AC1: Build zieht das gelistete #99 vor (schlägt älteres createdAt #10)" 99
assert_session_absent  "AC1: das ältere #10 bleibt unangetastet" 10

# ==============================================================================
# 2. Plan ordnet 'needs-plan': #5 älter, Queue listet #77 -> #77 gewählt.
# ==============================================================================
reset_state
list_json needs-plan '[
  {"number":5,"labels":[{"name":"needs-plan"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":77,"labels":[{"name":"needs-plan"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '## Plan
#77
'
run_main
assert_session_exists "AC2: Plan zieht das gelistete #77 vor" 77
assert_session_absent  "AC2: das ältere #5 bleibt unangetastet" 5

# ==============================================================================
# 3. Research ordnet 'needs-research': #54 älter, Queue listet #60 -> #60.
# ==============================================================================
reset_state
list_json needs-research '[
  {"number":54,"labels":[{"name":"needs-research"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":60,"labels":[{"name":"needs-research"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '## Research
#60
'
run_main
assert_session_exists "AC3: Research zieht das gelistete #60 vor" 60
assert_session_absent  "AC3: das ältere #54 bleibt unangetastet" 54

# ==============================================================================
# 4. Label bleibt das Tor: die Queue nennt #777, das aber KEIN ready-Label hat
#    (nicht in den Listen). Baubereit ist nur #10 -> #10 wird gewählt, NICHT #777.
# ==============================================================================
reset_state
list_json ready '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}
]'
queue_body_fixture 1000 '## Build
#777
#10
'
run_main
assert_session_exists "AC4: nur das gelabelte #10 wird gewählt" 10
assert_session_absent  "AC4: das ungelabelte Queue-Ziel #777 wird nicht baubereit" 777

# ==============================================================================
# 5. Nicht Gelistetes rutscht HINTER Gelistetes: #42 ist am ÄLTESTEN erstellt,
#    stünde ohne Queue vorn -- die Queue listet #99 -> #99 gewinnt trotzdem.
# ==============================================================================
reset_state
list_json ready '[
  {"number":42,"labels":[{"name":"ready"}],"createdAt":"2023-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
queue_body_fixture 1000 '## Build
#99
'
run_main
assert_session_exists "AC5: gelistetes #99 schlägt das ältere, ungelistete #42" 99
assert_session_absent  "AC5: das ungelistete #42 bleibt hinten" 42

# ==============================================================================
# 6. Kein Queue-Issue (QUEUE_ISSUE=0): exakt bisheriges Verhalten -- 'ready'
#    nach createdAt, also gewinnt das ÄLTERE #10.
# ==============================================================================
reset_state
list_json ready '[
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
( QUEUE_ISSUE=0; export QUEUE_ISSUE; main ) >/dev/null 2>&1
assert_session_exists "AC6: ohne Queue gewinnt das ältere createdAt (#10)" 10
assert_session_absent  "AC6: #99 (jünger) bleibt unangetastet" 99

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Prioritäts-Queue-Tests grün."
else
  red "Mindestens ein Prioritäts-Queue-Test ist rot (siehe oben)."
fi
exit $FAIL
