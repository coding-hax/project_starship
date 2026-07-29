#!/usr/bin/env bash
# AC3 von #366, End-zu-Ende: 'roundPlan -> round-prompt -> claude' traegt die
# bekannten Fund-Tickets tatsaechlich in den Prompt, der in `claude` gepipet
# wird -- nicht nur in die reinen Funktionen (die hat schon queue.test.ts).
#
# Muster wie scripts/tests/round-snap.test.sh/research-mode.test.sh: sourct
# claude-runner.sh (Source-Guard verhindert main() beim Sourcen), stubbt
# gh/git/claude per PATH-Shim. Der Prompt kommt via stdin in `claude`, nicht
# als Arg (#203, S6) -- der claude-Stub schreibt deshalb stdin mit weg.
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

# --- Stub 'gh' -----------------------------------------------------------
# 'issue list' ohne --label (ROUND_SNAP bzw. queue_snapshot()) baut sich aus
# den vier Ticketwahl-Fixtures zusammen -- ein labelloses Fund-Ticket packen
# die Faelle unten einfach mit in eine der vier Dateien, das Merge kennt
# keine Dateiherkunft, nur die 'labels'/'body'-Felder im JSON selbst zaehlen.
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
    if [ -n "$q" ]; then
      printf '%s' "$data" | jq -r "$q"
    else
      printf '%s' "$data"
    fi
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

# --- Stub 'git' ------------------------------------------------------------
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# --- Stub 'claude' -----------------------------------------------------------
# Argv + stdin (der Prompt, #203 S6) in eine Datei, damit die Assertions
# unten den tatsaechlich verschickten Auftragstext pruefen koennen.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
{ printf '%s\n' "$@"; cat; } > "$GHSTATE_DIR/claude-lastargs"
printf '%s' '{"session_id":"stub-session","result":"ok"}'
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
}

list_json() {   # $1 = Label, $2 = JSON-Array-Inhalt (roh)
  printf '%s' "$2" > "$GHSTATE_DIR/list-$1.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

assert_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = erwartete Teilzeichenkette
  if grep -qF "$3" "$2" 2>/dev/null; then
    ok "$1"
  else
    red "$1 (Teilstring '$3' fehlt in $2)"
  fi
}

assert_not_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = verbotene Teilzeichenkette
  if grep -qF "$3" "$2" 2>/dev/null; then
    red "$1 (Teilstring '$3' steht unerwartet in $2)"
  else
    ok "$1"
  fi
}

# ==============================================================================
# Fall A: ein 'ready'-Ticket wird gebaut, daneben liegt ein untriagiertes
# Fund-Ticket (kein Steuerlabel, Body traegt den Fundschluessel) im selben
# Schnappschuss -- der Prompt muss den Schluessel enthalten (AC3).
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json plan '[]'
list_json research '[]'
list_json ready '[
  {"number":77,"labels":[{"name":"ready"}],"createdAt":"2026-07-29T08:00:00Z","body":"Ganz normales Ticket."},
  {"number":349,"labels":[],"createdAt":"2026-07-29T09:36:00Z","body":"Fund: tests/aktivitaeten.spec.ts:608"}
]'
list_json needs-input '[]'
run_main
assert_contains "Fall A: Prompt enthaelt die Sektion 'Bekannte Fund-Tickets'" \
  "$GHSTATE_DIR/claude-lastargs" "Bekannte Fund-Tickets"
assert_contains "Fall A: Prompt nennt die Ticketnummer #349" \
  "$GHSTATE_DIR/claude-lastargs" "#349"
assert_contains "Fall A: Prompt nennt den Fundschluessel woertlich" \
  "$GHSTATE_DIR/claude-lastargs" "tests/aktivitaeten.spec.ts:608"

# ==============================================================================
# Fall B (Gegenprobe): nur das 'ready'-Ticket, kein Fund-Ticket im
# Schnappschuss -- die Sektion darf komplett fehlen.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json plan '[]'
list_json research '[]'
list_json ready '[
  {"number":78,"labels":[{"name":"ready"}],"createdAt":"2026-07-29T08:00:00Z","body":"Ganz normales Ticket."}
]'
list_json needs-input '[]'
run_main
assert_not_contains "Fall B: ohne Fund-Ticket fehlt die Sektion vollstaendig" \
  "$GHSTATE_DIR/claude-lastargs" "Bekannte Fund-Tickets"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Fundschluessel-Prompt-Tests grün."
else
  red "Mindestens ein Fundschluessel-Prompt-Test ist rot (siehe oben)."
fi
exit $FAIL
