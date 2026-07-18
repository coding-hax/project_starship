#!/usr/bin/env bash
# Tests für zwei Umbauten aus Issue #64:
#   1. ROUND_SNAP (die EINE 'gh issue list'-Abfrage statt fünf, siehe
#      run_round()) sortiert nach 'createdAt', nicht nach Issue-Nummer --
#      die Fixtures unten setzen Nummer und Erstell-Datum bewusst
#      gegenläufig, damit ein versehentlicher Rückfall auf sort_by(.number)
#      auffliegt.
#   2. Die Session-ID wird nach einem Lauf nur bei einem NICHT-leeren Treffer
#      überschrieben -- kaputtes/leeres $OUT (Notbremse-Fall) darf eine
#      gültige alte Session-ID nicht löschen.
# Reine Bash-Assertions, kein bats (keine neue Dependency). Sourct
# claude-runner.sh (Source-Guard verhindert, dass main() dabei losläuft) und
# stubbt gh/git/claude per PATH-Shim -- analog zu research-mode.test.sh,
# aber ohne dessen Rundenzählung (hier läuft jeder Testfall isoliert mit
# MAX_ROUNDS=1).
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
# 'issue list --label <L>' liest $G/list-<L>.json. Ein ungelabelter Aufruf
# (ROUND_SNAP bzw. queue_snapshot(), beide ohne --label) baut sich aus den
# vier Ticketwahl-Fixtures (in-progress/needs-plan/needs-research/ready)
# zusammen -- needs-input bleibt aussen vor (fragt waiting_issues() weiterhin
# gezielt gelabelt ab).
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

# --- Stub 'git' ----------------------------------------------------------------
# 'status --porcelain' fürs Read-only-Netz (sauberer Baum per Default).
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  status) exit 0 ;;
  *) exit 0 ;;
esac
STUB

# --- Stub 'claude' -------------------------------------------------------------
# Modus per CLAUDE_STUB_MODE: 'success' (Default) liefert eine gültige
# session_id, 'malformed' schreibt kaputtes/nicht-JSON in den Log (simuliert
# das, was nach einer Notbremse im Log steht) und bricht nicht-null ab.
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$GHSTATE_DIR/claude-lastargs"
case "${CLAUDE_STUB_MODE:-success}" in
  malformed)
    printf 'kaputte Ausgabe, kein JSON -- Notbremse mitten in der Antwort'
    exit 1
    ;;
  *)
    printf '%s' '{"session_id":"neue-session-xyz","result":"ok"}'
    exit 0
    ;;
esac
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
}

list_json() {   # $1 = Label, $2 = JSON-Array-Inhalt (roh)
  printf '%s' "$2" > "$GHSTATE_DIR/list-$1.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

assert_session_exists() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ -s "$STATE_DIR/session-$2" ]; then
    ok "$1"
  else
    red "$1 (kein session-$2 angelegt — falsches Ticket gewählt?)"
  fi
}

assert_session_absent() {   # $1 = Beschreibung, $2 = Issue-Nr
  if [ ! -e "$STATE_DIR/session-$2" ]; then
    ok "$1"
  else
    red "$1 (session-$2 existiert unerwartet)"
  fi
}

# ==============================================================================
# 1. ROUND_SNAP waehlt bei 'ready' nach createdAt, nicht nach Issue-Nummer --
#    #99 ist juenger nummeriert, aber AELTER erstellt als #10.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[
  {"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":10,"labels":[{"name":"ready"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
list_json needs-input '[]'
run_main
assert_session_exists "AC7: 'ready' waehlt das aeltere createdAt (#99), nicht die kleinere Nummer" 99
assert_session_absent "AC7: das juenger erstellte #10 bleibt unangetastet" 10

# ==============================================================================
# 2. Gleiches Bild bei 'needs-plan': #77 juenger nummeriert, aber aelter
#    erstellt als #5.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[
  {"number":77,"labels":[{"name":"needs-plan"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":5,"labels":[{"name":"needs-plan"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
list_json needs-research '[]'
list_json ready '[]'
list_json needs-input '[]'
run_main
assert_session_exists "AC7: 'needs-plan' waehlt das aeltere createdAt (#77), nicht die kleinere Nummer" 77
assert_session_absent "AC7: das juenger erstellte #5 bleibt unangetastet" 5

# ==============================================================================
# 3. Laufendes Ticket (WIP): zwei in-progress-Tickets ohne needs-input --
#    #50 juenger nummeriert, aber aelter erstellt als #3.
# ==============================================================================
reset_state
list_json in-progress '[
  {"number":50,"labels":[{"name":"in-progress"}],"createdAt":"2024-01-01T00:00:00Z"},
  {"number":3,"labels":[{"name":"in-progress"}],"createdAt":"2024-06-01T00:00:00Z"}
]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[]'
list_json needs-input '[]'
run_main
assert_session_exists "AC7: WIP-Fortsetzung waehlt das aeltere createdAt (#50), nicht die kleinere Nummer" 50
assert_session_absent "AC7: das juenger erstellte #3 bleibt unangetastet" 3

# ==============================================================================
# 4. Session-ID-Regel: kaputtes $OUT (Notbremse-Fall) ueberschreibt eine
#    gueltige alte Session-ID NICHT.
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":40,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]'
list_json needs-input '[]'
echo "alte-gueltige-session-id" > "$STATE_DIR/session-40"
(
  CLAUDE_STUB_MODE=malformed
  export CLAUDE_STUB_MODE
  main
) >/dev/null 2>&1
assert_eq "AC7: kaputtes \$OUT laesst die alte Session-ID unangetastet" \
  "alte-gueltige-session-id" "$(cat "$STATE_DIR/session-40" 2>/dev/null)"

# ==============================================================================
# 5. Session-ID-Regel: ein gueltiger Treffer ueberschreibt weiterhin ganz
#    normal (Gegenprobe -- die Regel darf nicht zu "nie mehr schreiben" kippen).
# ==============================================================================
reset_state
list_json in-progress '[]'
list_json needs-plan '[]'
list_json needs-research '[]'
list_json ready '[{"number":41,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]'
list_json needs-input '[]'
echo "alte-session-id" > "$STATE_DIR/session-41"
run_main
assert_eq "AC7: gueltiger Treffer ueberschreibt die Session-ID normal" \
  "neue-session-xyz" "$(cat "$STATE_DIR/session-41" 2>/dev/null)"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle ROUND_SNAP-/Session-ID-Tests grün."
else
  red "Mindestens ein ROUND_SNAP-/Session-ID-Test ist rot (siehe oben)."
fi
exit $FAIL
