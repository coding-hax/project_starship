#!/usr/bin/env bash
# Tests für #154: die CI-Wache aus #147 beobachtet nur das eine 'in-progress'-
# Ticket -- ein 'parked'-Ticket (#145) fällt durch beide Raster (kein
# 'in-progress' mehr, Ticketauswahl greift erst wieder bei fehlendem
# 'needs-input'). Wird sein PR in der Zwischenzeit komplett grün, blieb der
# Draft bisher für immer Draft. Diese Tests prüfen die eigenständige
# Parked-CI-Wache, die ALLE 'parked'-Tickets je Runde prüft -- ohne
# Agentenlauf. Reine Bash-Assertions, Harness wie ci-watch.test.sh.
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
# Wie ci-watch.test.sh: 'issue list' liefert immer den kompletten Snapshot
# (wip.json), Label-Filter werden ignoriert -- Mutationen laufen separat über
# labels-<issue>-Dateien, die 'issue view --json labels' und die Assertions
# lesen.
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
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
    if [ "$json" = "labels" ]; then
      cat "$G/labels-$issue" 2>/dev/null
    elif [ "$json" = "comments" ]; then
      cat "$G/lastcomment-$issue" 2>/dev/null
    fi
    ;;
  "issue edit")
    issue="$3"; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label)
          echo "$2" >> "$G/labels-$issue"
          shift 2 ;;
        --remove-label)
          grep -vx "$2" "$G/labels-$issue" 2>/dev/null > "$G/labels-$issue.tmp" || true
          mv -f "$G/labels-$issue.tmp" "$G/labels-$issue" 2>/dev/null || true
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
  "issue list")
    cat "$G/wip.json" 2>/dev/null || echo "[]"
    ;;
  "pr list")
    cat "$G/prlist.json" 2>/dev/null || echo "[]"
    ;;
  "pr checks")
    pr="$3"
    cat "$G/checks-$pr.json" 2>/dev/null || echo "[]"
    ;;
  "pr ready")
    pr="$3"
    touch "$G/ready-$pr"
    ;;
  "pr merge")
    shift 2
    pr=""
    for a in "$@"; do
      case "$a" in
        --*) ;;
        *) pr="$a" ;;
      esac
    done
    touch "$G/merged-$pr"
    ;;
  "run view")
    printf '  ✘ 1) e2e-main > tasks.spec.ts:42 > shows overdue task\n    Error: expect(received).toBe(expected)\n'
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ---------------------------------------------------------------
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# --- Stub 'claude' -------------------------------------------------------------
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
touch "$G/claude-called"
[ "${1:-}" = "-p" ] && printf '%s' "$2" > "$G/last-prompt"
printf '%s' '{"session_id":"stub","result":"ok"}'
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=999
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"
  mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
}

# $1 = Issue-Nr, $2 = "label1,label2" (leer = ohne Labels) -> registriert im
# Snapshot UND legt die passende labels-<issue>-Datei an (Quelle für
# 'issue view --json labels' und für die Mutation via 'issue edit').
seed_issue() {
  local n="$1" labels="${2:-}" created="${3:-2024-01-01T00:00:00Z}"
  : > "$GHSTATE_DIR/labels-$n"
  local labels_json='[]'
  if [ -n "$labels" ]; then
    printf '%s' "$labels" | tr ',' '\n' >> "$GHSTATE_DIR/labels-$n"
    labels_json=$(printf '%s' "$labels" | tr ',' '\n' | jq -R '{name: .}' | jq -s -c '.')
  fi
  local entry
  entry=$(jq -nc --argjson n "$n" --argjson l "$labels_json" --arg c "$created" \
    '{number:$n, labels:$l, createdAt:$c}')
  if [ -f "$GHSTATE_DIR/wip.json" ]; then
    jq -c --argjson e "$entry" '. + [$e]' "$GHSTATE_DIR/wip.json" > "$GHSTATE_DIR/wip.json.tmp"
    mv "$GHSTATE_DIR/wip.json.tmp" "$GHSTATE_DIR/wip.json"
  else
    printf '[%s]' "$entry" > "$GHSTATE_DIR/wip.json"
  fi
}

# $1 = Issue-Nr, $2 = PR-Nr -> registriert einen offenen PR auf dem
# konventionsgemäßen Branch für dieses Ticket (mehrere Aufrufe = mehrere PRs).
seed_pr() {
  local issue="$1" pr="$2" entry
  entry=$(jq -nc --argjson pr "$pr" --arg ref "fix/${issue}-parked-ci-watch" \
    '{number:$pr, headRefName:$ref}')
  if [ -f "$GHSTATE_DIR/prlist.json" ]; then
    jq -c --argjson e "$entry" '. + [$e]' "$GHSTATE_DIR/prlist.json" > "$GHSTATE_DIR/prlist.json.tmp"
    mv "$GHSTATE_DIR/prlist.json.tmp" "$GHSTATE_DIR/prlist.json"
  else
    printf '[%s]' "$entry" > "$GHSTATE_DIR/prlist.json"
  fi
}

labels_of() {
  sort "$GHSTATE_DIR/labels-$1" 2>/dev/null | tr '\n' ',' | sed 's/,$//'
}

assert_labels() {
  local got
  got=$(labels_of "$2")
  if [ "$got" = "$3" ]; then ok "$1"
  else red "$1 (erwartet '$3', bekommen '$got')"; fi
}

assert_file_absent() {
  if [ ! -e "$2" ]; then ok "$1"; else red "$1 (Datei existiert: $2)"; fi
}
assert_file_present() {
  if [ -e "$2" ]; then ok "$1"; else red "$1 (Datei fehlt: $2)"; fi
}
assert_contains() {
  local file="$3"
  if [ -f "$file" ] && grep -qF -- "$2" "$file"; then ok "$1"
  else red "$1 (nicht enthalten: '$2')"; fi
}

# ==============================================================================
# T1 -- geparktes Ticket, PR komplett grün -> freigegeben, ohne Agentenlauf
#       (deckt AC1 "grün, aber geparkt" + AC2 "kein Agentenlauf")
# ==============================================================================
reset_state
seed_issue 401 "needs-input,parked"
seed_pr 401 601
printf '[{"bucket":"pass","name":"quality"},{"bucket":"pass","name":"e2e"}]' \
  > "$GHSTATE_DIR/checks-601.json"
run_round
assert_labels "T1: #401 verliert parked UND needs-input" 401 ""
assert_file_present "T1: Draft #601 wird auf 'ready' gesetzt" "$GHSTATE_DIR/ready-601"
assert_file_present "T1: Auto-Merge für #601 wird aktiviert" "$GHSTATE_DIR/merged-601"
assert_file_absent "T1: kein Agentenlauf ausgelöst" "$GHSTATE_DIR/claude-called"

# ==============================================================================
# T2 -- geparktes Ticket, PR läuft noch (pending) -> unverändert geparkt
# ==============================================================================
reset_state
seed_issue 402 "needs-input,parked"
seed_pr 402 602
printf '[{"bucket":"pass","name":"quality"},{"bucket":"pending","name":"e2e"}]' \
  > "$GHSTATE_DIR/checks-602.json"
run_round
assert_labels "T2: #402 bleibt geparkt, solange CI noch läuft" 402 "needs-input,parked"
assert_file_absent "T2: kein Auto-Merge, solange CI noch läuft" "$GHSTATE_DIR/merged-602"

# ==============================================================================
# T3 -- geparktes Ticket, PR rot -> unverändert geparkt
# ==============================================================================
reset_state
seed_issue 403 "needs-input,parked"
seed_pr 403 603
printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"e2e"}]' \
  > "$GHSTATE_DIR/checks-603.json"
run_round
assert_labels "T3: #403 bleibt geparkt, solange CI rot ist" 403 "needs-input,parked"
assert_file_absent "T3: kein Auto-Merge bei roter CI" "$GHSTATE_DIR/merged-603"

# ==============================================================================
# T4 -- ein laufendes Ticket wird bevorzugt behandelt, die Prüfung eines
#       gleichzeitig geparkten (grünen) Tickets verzögert es nicht: der
#       Bau-Agent für das laufende Ticket läuft trotzdem in derselben Runde.
# ==============================================================================
reset_state
seed_issue 404 "in-progress"
seed_issue 410 "needs-input,parked"
seed_pr 410 610
printf '[{"bucket":"pass","name":"quality"},{"bucket":"pass","name":"e2e"}]' \
  > "$GHSTATE_DIR/checks-610.json"
run_round
assert_file_present "T4: der Bau-Agent für das laufende #404 läuft trotzdem" \
  "$GHSTATE_DIR/claude-called"
assert_labels "T4: das geparkte #410 wird trotzdem freigegeben" 410 ""
assert_file_present "T4: Auto-Merge für #610 wird aktiviert" "$GHSTATE_DIR/merged-610"

# ==============================================================================
# T5 -- mehrere gleichzeitig geparkte Tickets werden ALLE geprüft, nicht nur
#       das erste: eins grün (freigegeben), eins noch pending (bleibt geparkt).
# ==============================================================================
reset_state
seed_issue 501 "parked"
seed_pr 501 701
printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-701.json"
seed_issue 502 "needs-input,parked"
seed_pr 502 702
printf '[{"bucket":"pending","name":"e2e"}]' > "$GHSTATE_DIR/checks-702.json"
run_round
assert_labels "T5: #501 (grün) wird freigegeben" 501 ""
assert_file_present "T5: Auto-Merge für #701 wird aktiviert" "$GHSTATE_DIR/merged-701"
assert_labels "T5: #502 (pending) bleibt unverändert geparkt" 502 "needs-input,parked"
assert_file_absent "T5: kein Auto-Merge für #702" "$GHSTATE_DIR/merged-702"

# ==============================================================================
# T6 -- das Statusticket macht sichtbar, dass ein geparktes Ticket freigegeben
#       wurde.
# ==============================================================================
reset_state
seed_issue 600 "parked"
seed_pr 600 800
printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-800.json"
run_round
assert_contains "T6: Status nennt die Freigabe" "Geparktes Ticket freigegeben" \
  "$GHSTATE_DIR/status-body-log"
assert_contains "T6: Status nennt das freigegebene Ticket #600" "#600" \
  "$GHSTATE_DIR/status-body-log"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Parked-CI-Wache-Tests grün."
else
  red "Mindestens ein Parked-CI-Wache-Test ist rot (siehe oben)."
fi
exit $FAIL
