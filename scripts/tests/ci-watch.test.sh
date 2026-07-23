#!/usr/bin/env bash
# Tests für die CI-Wache (#147): der Bau-Agent endet beim Push, der Runner-TAKT
# beobachtet ab dann die CI eines offenen Draft-PR -- kein Agentenlauf fuers
# Warten, kein Wechsel auf ein anderes Ticket, solange hier noch etwas offen
# ist. Reine Bash-Assertions, kein bats -- Harness 1:1 wie opus-boost.test.sh.
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
# Erweitert das Muster aus opus-boost.test.sh um 'pr list/checks/ready/merge'
# und faengt den Status-Titel ab (fuer die "CI läuft"-Sichtbarkeitspruefung).
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
          echo "$2" > "$G/status-title"
          shift 2 ;;
        --body)
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
  "pr view")
    pr="$3"
    cat "$G/mergestate-$pr.json" 2>/dev/null \
      || printf '{"headRefName":"unknown","mergeStateStatus":"CLEAN"}'
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
# Erweitert um das, was pr_catch_up_behind() (#160) braucht: ein steuerbares
# 'merge' (Konflikt via Marker-Datei), passende Antworten fuer status/diff/
# rev-parse. Alles andere (fetch/checkout/push/merge --abort) bleibt ein
# folgenloses exit 0, wie zuvor.
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
case "${1:-}" in
  status)
    [ -e "$G/git-dirty" ] && printf ' M some/file.ts\n'
    exit 0
    ;;
  rev-parse)
    printf 'main\n'
    exit 0
    ;;
  merge)
    case "${2:-}" in
      --abort) exit 0 ;;
      *) [ -e "$G/git-merge-conflict" ] && exit 1; exit 0 ;;
    esac
    ;;
  diff)
    [ -e "$G/git-merge-conflict" ] && printf 'src/a.ts\nsrc/b.ts\n'
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB

# --- Stub 'claude' -------------------------------------------------------------
# Schreibt den erhaltenen Prompt weg (-p ist $1, Prompttext $2), damit Tests
# pruefen koennen, WELCHER Prompt (normal vs. CI_FIX) tatsaechlich lief -- und
# ob ueberhaupt ein Agent lief.
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

# $1 = Issue-Nr -> setzt 'in-progress' + Snapshot mit GENAU diesem Ticket.
setup_wip_issue() {
  local issue="$1"
  : > "$GHSTATE_DIR/labels-$issue"
  echo "in-progress" >> "$GHSTATE_DIR/labels-$issue"
  printf '[{"number":%s,"labels":[{"name":"in-progress"}],"createdAt":"2026-01-01T00:00:00Z"}]' \
    "$issue" > "$GHSTATE_DIR/wip.json"
}

# $1 = Issue-Nr, $2 = PR-Nr -> registriert einen offenen PR auf dem
# konventionsgemaessen Branch fuer dieses Ticket.
setup_pr() {
  local issue="$1" pr="$2"
  printf '[{"number":%s,"headRefName":"fix/%s-runner-ci-watch"}]' "$pr" "$issue" \
    > "$GHSTATE_DIR/prlist.json"
}

# $1 = Issue-Nr, $2 = PR-Nr -> markiert den PR als hinter 'main' (#160),
# alle Checks gruen -- genau die Konstellation, in der die Wache die
# Reihenfolge pending -> failing -> behind -> success anwenden muss.
setup_behind() {
  local issue="$1" pr="$2"
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"pass","name":"e2e"}]' \
    > "$GHSTATE_DIR/checks-$pr.json"
  printf '{"headRefName":"fix/%s-runner-ci-watch","mergeStateStatus":"BEHIND"}' \
    "$issue" > "$GHSTATE_DIR/mergestate-$pr.json"
}

assert_file_absent() {
  if [ ! -e "$2" ]; then ok "$1"; else red "$1 (Datei existiert: $2)"; fi
}
assert_file_present() {
  if [ -e "$2" ]; then ok "$1"; else red "$1 (Datei fehlt: $2)"; fi
}
assert_contains() {
  case "$3" in *"$2"*) ok "$1" ;; *) red "$1 (nicht enthalten: '$2')" ;; esac
}
assert_not_contains() {
  case "$3" in *"$2"*) red "$1 (unerwartet enthalten: '$2')" ;; *) ok "$1" ;; esac
}

# ==============================================================================
# T1 -- CI läuft noch (mind. ein Check pending) -> kein Agentenlauf, kein Merge
# ==============================================================================
reset_state
setup_wip_issue 301
setup_pr 301 501
printf '[{"bucket":"pass","name":"quality"},{"bucket":"pending","name":"e2e"}]' \
  > "$GHSTATE_DIR/checks-501.json"
run_round
assert_file_absent "T1: kein Agentenlauf, solange CI noch läuft" "$GHSTATE_DIR/claude-called"
assert_file_absent "T1: kein Auto-Merge, solange CI noch läuft" "$GHSTATE_DIR/merged-501"
assert_contains "T1: Status zeigt 'CI läuft', nicht 'arbeitet'" \
  "CI läuft" "$(cat "$GHSTATE_DIR/status-title" 2>/dev/null)"
IN_PROGRESS_301=$(cat "$GHSTATE_DIR/labels-301" 2>/dev/null | tr '\n' ' ')
case "$IN_PROGRESS_301" in
  *in-progress*) ok "T1: Ticket bleibt in-progress, solange die CI läuft" ;;
  *) red "T1: Ticket bleibt in-progress, solange die CI läuft (Labels: $IN_PROGRESS_301)" ;;
esac

# ==============================================================================
# T2 -- CI grün -> ready + Auto-Merge, ohne Agentenlauf
# ==============================================================================
reset_state
setup_wip_issue 302
setup_pr 302 502
printf '[{"bucket":"pass","name":"quality"},{"bucket":"pass","name":"e2e"},{"bucket":"skipping","name":"protected-paths"}]' \
  > "$GHSTATE_DIR/checks-502.json"
run_round
assert_file_absent "T2: kein Agentenlauf bei grüner CI" "$GHSTATE_DIR/claude-called"
assert_file_present "T2: Draft wird auf 'ready' gesetzt" "$GHSTATE_DIR/ready-502"
assert_file_present "T2: Auto-Merge wird aktiviert" "$GHSTATE_DIR/merged-502"

# ==============================================================================
# T3 -- CI rot (nicht nur protected-paths) -> gezielter Fix-Agent mit Summary
# ==============================================================================
reset_state
setup_wip_issue 303
setup_pr 303 503
printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"e2e","description":"2 tests failed in shard 2","link":"https://github.com/coding-hax/project_starship/actions/runs/999999/job/111"}]' \
  > "$GHSTATE_DIR/checks-503.json"
run_round
assert_file_present "T3: ein Fix-Agent läuft bei rotem Nicht-protected-paths-Check" \
  "$GHSTATE_DIR/claude-called"
assert_file_absent "T3: kein Auto-Merge bei rotem Check" "$GHSTATE_DIR/merged-503"
PROMPT_503=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T3: Auftrag nennt den fehlgeschlagenen Job" "e2e" "$PROMPT_503"
assert_contains "T3: Auftrag nennt die Kurzbeschreibung" "2 tests failed in shard 2" "$PROMPT_503"
assert_contains "T3: Auftrag ist der CI-Fix-Prompt (Was rot ist)" "Was rot ist" "$PROMPT_503"
assert_not_contains "T3: NICHT der generische Bau-Prompt" \
  "Pflichtlektüre ist NUR CLAUDE.md" "$PROMPT_503"

# ==============================================================================
# T4 -- CI rot NUR bei protected-paths -> needs-input, kein Fix-Agent
# ==============================================================================
reset_state
setup_wip_issue 304
setup_pr 304 504
printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"protected-paths","description":"Approval missing"}]' \
  > "$GHSTATE_DIR/checks-504.json"
run_round
assert_file_absent "T4: kein Agentenlauf bei rotem protected-paths allein" \
  "$GHSTATE_DIR/claude-called"
LABELS_304=$(cat "$GHSTATE_DIR/labels-304" 2>/dev/null | tr '\n' ' ')
case "$LABELS_304" in
  *needs-input*) ok "T4: needs-input wird gesetzt -- das ist die Genehmigungs-Schranke" ;;
  *) red "T4: needs-input wird gesetzt (Labels: $LABELS_304)" ;;
esac
assert_file_absent "T4: kein Auto-Merge, solange protected-paths rot ist" "$GHSTATE_DIR/merged-504"

# ==============================================================================
# T5 -- Noch kein PR (Agent mitten in der Arbeit) -> normaler Bau-Pfad läuft
# ==============================================================================
reset_state
setup_wip_issue 305
: > "$GHSTATE_DIR/prlist.json"   # kein offener PR für #305
printf '[]' > "$GHSTATE_DIR/prlist.json"
run_round
assert_file_present "T5: ohne offenen PR läuft der normale Bau-Agent weiter" \
  "$GHSTATE_DIR/claude-called"
PROMPT_305=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T5: es ist der generische Bau-Prompt" \
  "Pflichtlektüre ist NUR CLAUDE.md" "$PROMPT_305"
assert_not_contains "T5: NICHT der CI-Fix-Prompt" "Was rot ist" "$PROMPT_305"

# ==============================================================================
# T6 -- Läuft CI zu #306, wählt der Takt KEIN anderes ready-Ticket (#310)
# ==============================================================================
reset_state
: > "$GHSTATE_DIR/labels-306"
echo "in-progress" >> "$GHSTATE_DIR/labels-306"
: > "$GHSTATE_DIR/labels-310"
echo "ready" >> "$GHSTATE_DIR/labels-310"
printf '[
  {"number":306,"labels":[{"name":"in-progress"}],"createdAt":"2026-01-01T00:00:00Z"},
  {"number":310,"labels":[{"name":"ready"}],"createdAt":"2025-01-01T00:00:00Z"}
]' > "$GHSTATE_DIR/wip.json"
printf '[{"number":606,"headRefName":"fix/306-runner-ci-watch"}]' > "$GHSTATE_DIR/prlist.json"
printf '[{"bucket":"pending","name":"e2e"}]' > "$GHSTATE_DIR/checks-606.json"
run_round
assert_file_absent "T6: kein Agentenlauf, während #306 auf CI wartet" \
  "$GHSTATE_DIR/claude-called"
LABELS_310=$(cat "$GHSTATE_DIR/labels-310" 2>/dev/null | tr '\n' ' ')
case "$LABELS_310" in
  *in-progress*) red "T6: #310 wird NICHT angefasst, während #306 auf CI wartet (Labels: $LABELS_310)" ;;
  *) ok "T6: #310 wird nicht angefasst, während #306 auf CI wartet" ;;
esac

# ==============================================================================
# T7 -- PR liegt hinter main, Checks grün, kein Konflikt (#160) -> per git
#       nachgezogen und gepusht, KEIN Agentenlauf, KEIN Auto-Merge (CI muss
#       nach dem Push erst neu laufen)
# ==============================================================================
reset_state
setup_wip_issue 401
setup_pr 401 701
setup_behind 401 701
run_round
assert_file_absent "T7: kein Agentenlauf beim reinen Nachziehen" "$GHSTATE_DIR/claude-called"
assert_file_absent "T7: kein Auto-Merge direkt nach dem Nachziehen" "$GHSTATE_DIR/merged-701"
assert_contains "T7: Status zeigt wieder 'CI läuft'" \
  "CI läuft" "$(cat "$GHSTATE_DIR/status-title" 2>/dev/null)"
IN_PROGRESS_401=$(cat "$GHSTATE_DIR/labels-401" 2>/dev/null | tr '\n' ' ')
case "$IN_PROGRESS_401" in
  *in-progress*) ok "T7: Ticket bleibt in-progress nach dem Nachziehen" ;;
  *) red "T7: Ticket bleibt in-progress nach dem Nachziehen (Labels: $IN_PROGRESS_401)" ;;
esac

# ==============================================================================
# T8 -- Nachziehen scheitert an einem echten Merge-Konflikt -> Fix-Agent mit
#       den Konfliktdateien im Auftrag, sauberer Arbeitsbaum (kein Auto-Merge)
# ==============================================================================
reset_state
setup_wip_issue 402
setup_pr 402 702
setup_behind 402 702
touch "$GHSTATE_DIR/git-merge-conflict"
run_round
assert_file_present "T8: ein Fix-Agent läuft bei einem Merge-Konflikt" \
  "$GHSTATE_DIR/claude-called"
assert_file_absent "T8: kein Auto-Merge bei einem Merge-Konflikt" "$GHSTATE_DIR/merged-702"
PROMPT_702=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T8: Auftrag nennt den Merge-Konflikt" "Merge-Konflikt" "$PROMPT_702"
assert_contains "T8: Auftrag nennt die Konfliktdatei a.ts" "src/a.ts" "$PROMPT_702"
assert_contains "T8: Auftrag nennt die Konfliktdatei b.ts" "src/b.ts" "$PROMPT_702"
assert_not_contains "T8: kein 'gh pr update-branch' im Auftrag" "update-branch" "$PROMPT_702"

# ==============================================================================
# T9 -- Auch ein GEPARKTES Ticket (#154) mit zurückgefallenem PR wird per git
#       nachgezogen -- OHNE ein parallel laufendes in-progress-Ticket zu
#       stören und OHNE selbst einen Agenten zu starten (WIP-Limit=1)
# ==============================================================================
reset_state
: > "$GHSTATE_DIR/labels-410"
echo "in-progress" >> "$GHSTATE_DIR/labels-410"
: > "$GHSTATE_DIR/labels-403"
echo "parked" >> "$GHSTATE_DIR/labels-403"
printf '[
  {"number":410,"labels":[{"name":"in-progress"}],"createdAt":"2026-01-01T00:00:00Z"},
  {"number":403,"labels":[{"name":"parked"}],"createdAt":"2025-01-01T00:00:00Z"}
]' > "$GHSTATE_DIR/wip.json"
printf '[{"number":810,"headRefName":"fix/410-runner-ci-watch"},{"number":703,"headRefName":"fix/403-runner-ci-watch"}]' \
  > "$GHSTATE_DIR/prlist.json"
printf '[{"bucket":"pending","name":"e2e"}]' > "$GHSTATE_DIR/checks-810.json"
setup_behind 403 703
run_round
assert_file_absent "T9: kein Agentenlauf beim Nachziehen eines geparkten Tickets" \
  "$GHSTATE_DIR/claude-called"
assert_file_absent "T9: kein Auto-Merge direkt nach dem Nachziehen (geparkt)" \
  "$GHSTATE_DIR/merged-703"
assert_file_absent "T9: das laufende Ticket wird durchs Nachziehen nicht gestört" \
  "$GHSTATE_DIR/merged-810"
LABELS_403=$(cat "$GHSTATE_DIR/labels-403" 2>/dev/null | tr '\n' ' ')
case "$LABELS_403" in
  *parked*) ok "T9: Ticket bleibt geparkt, bis CI nach dem Nachziehen neu grün ist" ;;
  *) red "T9: Ticket bleibt geparkt (Labels: $LABELS_403)" ;;
esac

# ==============================================================================
# T10 -- Bau-Prompt weist an: geschuetzten Pfad beim Oeffnen des Draft-PR
#        SELBST als needs-input markieren und in diesem Lauf nicht wieder
#        abnehmen (#163) -- die Wache bleibt nur das Sicherheitsnetz
# ==============================================================================
reset_state
setup_wip_issue 320
printf '[]' > "$GHSTATE_DIR/prlist.json"   # noch kein PR -> generischer Bau-Prompt
run_round
PROMPT_320=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T10: Bau-Prompt weist an, needs-input bei geschuetzten Pfaden selbst zu setzen" \
  "add-label needs-input" "$PROMPT_320"
assert_contains "T10: Bau-Prompt untersagt, es im selben Lauf wieder abzunehmen" \
  "NICHT wieder ab" "$PROMPT_320"

# ==============================================================================
# T11 -- protected-paths allein rot, needs-input haengt bereits dran (z. B.
#        vom Bau-Agent selbst gesetzt, #163) -> erneutes Setzen durch die
#        Wache bleibt folgenlos, kein Fehler, kein Fix-Agent, kein Auto-Merge
# ==============================================================================
reset_state
setup_wip_issue 306
setup_pr 306 506
: > "$GHSTATE_DIR/labels-306"
printf 'in-progress\nneeds-input\n' >> "$GHSTATE_DIR/labels-306"
printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"protected-paths","description":"Approval missing"}]' \
  > "$GHSTATE_DIR/checks-506.json"
run_round
assert_file_absent "T11: kein Agentenlauf, needs-input haengt schon vom Bau-Agent" \
  "$GHSTATE_DIR/claude-called"
LABELS_306=$(cat "$GHSTATE_DIR/labels-306" 2>/dev/null | tr '\n' ' ')
case "$LABELS_306" in
  *needs-input*) ok "T11: needs-input bleibt stehen, erneutes Setzen ist folgenlos" ;;
  *) red "T11: needs-input bleibt stehen (Labels: $LABELS_306)" ;;
esac
assert_file_absent "T11: kein Auto-Merge, solange protected-paths rot ist" "$GHSTATE_DIR/merged-506"

# ==============================================================================
# T12 -- Bau-Prompt (#167): weist an, den PR am sauberen Ende SELBST aus dem
#        Entwurf zu heben und Auto-Merge zu aktivieren, ohne auf CI-Gruen zu
#        warten -- statt auf den naechsten Wache-Takt
# ==============================================================================
reset_state
setup_wip_issue 321
printf '[]' > "$GHSTATE_DIR/prlist.json"   # noch kein PR -> generischer Bau-Prompt
run_round
PROMPT_321=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T12: Bau-Prompt weist an, 'gh pr ready' selbst auszufuehren" \
  "gh pr ready" "$PROMPT_321"
assert_contains "T12: Bau-Prompt weist an, Auto-Merge selbst zu aktivieren" \
  "gh pr merge --squash --auto --delete-branch" "$PROMPT_321"

# ==============================================================================
# T13 -- Bau-Prompt (#167): auch im Zweig fuer geschuetzte Pfade bleibt die
#        Anweisung stehen -- needs-input haelt das Ticket geparkt, aber der
#        PR soll trotzdem kein Entwurf mehr sein ('protected-paths' haelt ihn
#        ohnehin rot, bis ein Mensch freigibt)
# ==============================================================================
reset_state
setup_wip_issue 322
printf '[]' > "$GHSTATE_DIR/prlist.json"
run_round
PROMPT_322=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T13: Bau-Prompt haelt an 'gh pr ready' fest, auch bei needs-input aus Schritt 7" \
  "wegen eines" "$PROMPT_322"
assert_contains "T13: Bau-Prompt erwaehnt, dass protected-paths trotzdem rot haelt" \
  "protected-paths" "$PROMPT_322"

# ==============================================================================
# T14 -- CI-Fix-Prompt (#167): erhaelt dieselbe Anweisung -- der Fix-Agent
#        raeumt das Sicherheitsnetz mit auf, statt sich auf einen frueheren
#        Lauf zu verlassen
# ==============================================================================
reset_state
setup_wip_issue 323
setup_pr 323 523
printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"e2e","description":"1 test failed"}]' \
  > "$GHSTATE_DIR/checks-523.json"
run_round
PROMPT_523=$(cat "$GHSTATE_DIR/last-prompt" 2>/dev/null)
assert_contains "T14: CI-Fix-Prompt ist der richtige (Was rot ist)" "Was rot ist" "$PROMPT_523"
assert_contains "T14: CI-Fix-Prompt weist an, 'gh pr ready' selbst auszufuehren" \
  "gh pr ready" "$PROMPT_523"
assert_contains "T14: CI-Fix-Prompt weist an, Auto-Merge selbst zu aktivieren" \
  "gh pr merge --squash --auto --delete-branch" "$PROMPT_523"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle CI-Wache-Tests grün."
else
  red "Mindestens ein CI-Wache-Test ist rot (siehe oben)."
fi
exit $FAIL
