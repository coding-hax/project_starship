#!/usr/bin/env bash
# Tests für #145: ein Ticket, das auf 'needs-input' gesetzt wird, verliert im
# selben Zug 'in-progress' (Label 'parked') -- vorher blockierte ein
# wartendes Ticket den ganzen Runner, auch für fachlich unabhängige Tickets
# (#118/#126/#131). Reine Bash-Assertions, kein bats -- Harness wie
# opus-boost.test.sh/chaining.test.sh, aber mit EINEM gemeinsamen
# issues.json als Quelle der Wahrheit für alle 'issue list/edit/view'-Aufrufe,
# damit Mutationen (Selbstheilung, Wiederaufnahme) sofort in den nächsten
# Abfragen derselben oder einer neuen Runde sichtbar sind.
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
# EIN Roster ($GHSTATE_DIR/issues.json), gegen das 'issue list' (mit/ohne
# --label), 'issue edit' (Label-Mutation) und 'issue view' (Labels/Comments)
# gemeinsam arbeiten -- Mutationen sind sofort für jede folgende Abfrage
# sichtbar, egal ob innerhalb derselben Runde oder in einem neuen 'run_main'.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"
DB="$G/issues.json"
[ -f "$DB" ] || echo '[]' > "$DB"

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
      data=$(jq -c --arg l "$label" '[.[] | select(.labels | map(.name) | index($l))]' "$DB")
    else
      data=$(cat "$DB")
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
          echo "ADD:$add" >> "$G/applied-$issue"
          shift 2 ;;
        --remove-label)
          rem="$2"
          tmp=$(jq --arg n "$issue" --arg l "$rem" \
            'map(if (.number|tostring) == $n
                 then .labels |= map(select(.name != $l))
                 else . end)' "$DB")
          printf '%s' "$tmp" > "$DB"
          echo "REMOVE:$rem" >> "$G/applied-$issue"
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
  *) : ;;
esac
exit 0
STUB

# --- Stub 'git' ---------------------------------------------------------------
# Kein Fortschritt (branch_tip liefert nie einen Treffer), sauberer Baum --
# hält build_escalation_eval im harmlosen "kein Fortschritt, fc<3"-Zweig,
# ohne dass ein Tier-Wechsel die Tests verkompliziert.
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# --- Stub 'claude' -------------------------------------------------------------
# 'asks_question': simuliert genau das, was der echte Agent tut, wenn er eine
# Frage stellt -- er setzt das Label selbst per 'gh issue edit' (der Stub
# darüber ist im PATH, der Aufruf landet also im selben issues.json).
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
echo x >> "$G/claude-calls"
printf '%s\n' "$@" > "$G/claude-lastargs-$(wc -l < "$G/claude-calls" | tr -d ' ')"
case "${CLAUDE_STUB_MODE:-success}" in
  asks_question)
    gh issue edit "${CLAUDE_STUB_TARGET_ISSUE}" --add-label needs-input >/dev/null 2>&1
    ;;
esac
printf '%s' '{"session_id":"stub-session","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export QUEUE_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  echo '[]' > "$GHSTATE_DIR/issues.json"
  unset CLAUDE_STUB_MODE CLAUDE_STUB_TARGET_ISSUE
}

seed_issue() {   # $1 = Nr, $2 = "label1,label2", $3 = createdAt (optional)
  local n="$1" labels="$2" created="${3:-2024-01-01T00:00:00Z}" labels_json tmp
  labels_json=$(printf '%s' "$labels" | tr ',' '\n' | jq -R '{name: .}' | jq -s -c '.')
  tmp=$(jq --argjson n "$n" --argjson l "$labels_json" --arg c "$created" \
    '. + [{number:$n, labels:$l, createdAt:$c}]' "$GHSTATE_DIR/issues.json")
  printf '%s' "$tmp" > "$GHSTATE_DIR/issues.json"
}

run_main() { ( main ) >/dev/null 2>&1; }

labels_of() {   # $1 = Nr -> sortierte, kommaseparierte Labelliste
  jq -r --arg n "$1" \
    '[.[] | select((.number|tostring) == $n) | .labels[].name] | sort | join(",")' \
    "$GHSTATE_DIR/issues.json"
}

assert_labels() {   # $1 = Beschreibung, $2 = Nr, $3 = erwartete (sortierte) Labels
  local got
  got=$(labels_of "$2")
  if [ "$got" = "$3" ]; then ok "$1"
  else red "$1 (erwartet '$3', bekommen '$got')"; fi
}

call_count() {
  [ -f "$GHSTATE_DIR/claude-calls" ] && wc -l < "$GHSTATE_DIR/claude-calls" | tr -d ' ' || echo 0
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then ok "$1"; else red "$1 (erwartet '$2', bekommen '$3')"; fi
}

assert_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = erwarteter Substring
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then ok "$1"
  else red "$1 (Substring '$3' fehlt in $2)"; fi
}

assert_not_contains() {   # $1 = Beschreibung, $2 = Datei, $3 = unerwarteter Substring
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then red "$1 (Substring '$3' unerwartet in $2)"
  else ok "$1"; fi
}

# ==============================================================================
# 1. Selbstheilung: ein Ticket steht (aus einem frueheren Lauf) mit
#    in-progress+needs-input da. Der naechste Takt loest das auf (parked statt
#    in-progress) UND waehlt trotzdem ein neues, baubereites Ticket -- statt
#    wie vorher alles zu blockieren.
# ==============================================================================
reset_state
seed_issue 50 "in-progress,needs-input"
seed_issue 70 "ready"
run_main
assert_labels  "AC1: #50 verliert in-progress, behaelt needs-input, wird parked" 50 "needs-input,parked"
assert_labels  "AC2: #70 wird stattdessen gebaut (in-progress statt ready)" 70 "in-progress"
assert_eq      "AC5: genau EIN Ticket wurde tatsaechlich gebaut" "1" "$(call_count)"

# ==============================================================================
# 2. Wiederaufnahme: die Frage an #50 ist beantwortet (needs-input weg), nur
#    'parked' haengt noch. Das geht vor einem frischen 'ready'-Ticket -- und
#    zwar als Resume (bestehende Session wird per --resume fortgesetzt), nicht
#    als Neustart.
# ==============================================================================
reset_state
seed_issue 50 "parked" "2024-01-01T00:00:00Z"
seed_issue 70 "ready"  "2024-01-02T00:00:00Z"
printf 'sid-50' > "$STATE_DIR/session-50"
run_main
assert_labels "AC3: #50 wird fortgesetzt (in-progress statt parked)" 50 "in-progress"
assert_labels "AC3: #70 bleibt unangetastet, solange #50 laeuft" 70 "ready"
assert_contains "AC4: die bestehende Session wird per --resume fortgesetzt" \
  "$GHSTATE_DIR/claude-lastargs-1" "sid-50"

# ==============================================================================
# 3. Der Agent selbst stellt waehrend des laufenden Baus eine Frage: 'parked'
#    muss SOFORT stehen (nicht erst beim naechsten Takt), 'needs-input' bleibt.
# ==============================================================================
reset_state
seed_issue 60 "in-progress"
export CLAUDE_STUB_MODE=asks_question
export CLAUDE_STUB_TARGET_ISSUE=60
run_main
unset CLAUDE_STUB_MODE CLAUDE_STUB_TARGET_ISSUE
assert_labels "AC1: eigene Frage waehrend des Laufs parkt sofort (kein Warten auf den naechsten Takt)" \
  60 "needs-input,parked"

# ==============================================================================
# 4. Ein UNABHAENGIGES, bereits wartendes Ticket darf einen sauberen,
#    unabhaengigen Lauf nicht als "wartet auf dich" fehldeuten -- die Kette
#    muss trotzdem weiterlaufen (Regression: vorher pruefte der Runner den
#    kompletten Bestand statt nur das gerade gebaute Ticket).
# ==============================================================================
reset_state
seed_issue 61 "needs-input,parked"
seed_issue 60 "in-progress"
seed_issue 90 "ready"
MAX_ROUNDS=2
run_main
MAX_ROUNDS=1
assert_eq "AC2: die Kette laeuft trotz eines fremden wartenden Tickets weiter (2 Runden)" "2" "$(call_count)"
assert_labels "AC5: das fremde wartende Ticket bleibt unangetastet" 61 "needs-input,parked"

# ==============================================================================
# 5. Status-Ticket (AC6): waehrend an einem Ticket gearbeitet wird, bleibt ein
#    ANDERES, wartendes ('parked') Ticket im Status sichtbar.
# ==============================================================================
reset_state
seed_issue 61 "needs-input,parked"
seed_issue 70 "ready"
export STATUS_ISSUE=999
run_main
unset STATUS_ISSUE
assert_contains "AC6: die 'arbeitet an'-Statusmeldung wurde geschrieben" \
  "$GHSTATE_DIR/status-body-log" "Arbeitet gerade an #70"
assert_contains "AC6: ...und nennt das wartende Ticket #61 mit" \
  "$GHSTATE_DIR/status-body-log" "#61"

# ==============================================================================
# 6. Niemals doppeltes WIP: nach der Selbstheilung + Neuwahl traegt am Ende
#    genau EIN Ticket 'in-progress'.
# ==============================================================================
reset_state
seed_issue 50 "in-progress,needs-input"
seed_issue 70 "ready"
run_main
WIP_COUNT=$(jq '[.[] | select(.labels | map(.name) | index("in-progress"))] | length' \
              "$GHSTATE_DIR/issues.json")
assert_eq "AC5: nach der Runde traegt genau ein Ticket in-progress" "1" "$WIP_COUNT"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Parked-Label-Tests grün."
else
  red "Mindestens ein Parked-Label-Test ist rot (siehe oben)."
fi
exit $FAIL
