#!/usr/bin/env bash
# Tests für #202 (S5 von #184): stdout/Exit-Code der neun portierten
# Wache-/Ticketauswahl-Funktionen (self_heal_park, pick_ticket, waiting_issues,
# parked_issues, park_issue, queue_snapshot, queue_body, watch_running_issue,
# watch_parked_issues) müssen über ts_run (RUNNER_TS=1, echtes tsx/cli.ts) und
# über den Bash-Pfad (RUNNER_TS=0) IDENTISCH sein -- AC7 wörtlich
# ("RUNNER_TS=0 als Vergleichsläufer").
#
# Gleiches Grundgerüst wie runner-ts-s4-parity.test.sh: REPO_DIR zeigt auf das
# ECHTE Repo (damit ts_run ein echtes tsx + cli.ts zu fassen bekommt),
# STATE_DIR UND GHSTATE_DIR zeigen dagegen je Pfad auf ein eigenes
# Wegwerf-Verzeichnis. park_issue/self_heal_park/pick_ticket haben teils keinen
# eigenen stdout-Vertrag (reine gh-Seiteneffekte) -- dort vergleichen wir die
# resultierenden GHSTATE-Marker-Dateien statt/zusätzlich zu stdout.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$TEST_DIR/../claude-runner.sh"
REAL_REPO_DIR="$(cd "$TEST_DIR/../.." && pwd)"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

if [ ! -x "$REAL_REPO_DIR/node_modules/.bin/tsx" ]; then
  red "Vorbedingung: node_modules/.bin/tsx fehlt -- 'pnpm install' zuerst ausführen."
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKEBIN="$TMP/bin"
mkdir -p "$FAKEBIN"
export GHSTATE_DIR="$TMP/ghstate-init"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' -- Obermenge aus runner-ts-s4-parity.test.sh + parked-label.test.sh
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
      data=$(cat "$G/queue-snapshot.json" 2>/dev/null || echo '[]')
    fi
    if [ -n "$q" ]; then printf '%s' "$data" | jq -r "$q"; else printf '%s' "$data"; fi
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
    if [ "$json" = "body" ]; then
      body=$(cat "$G/body-$issue" 2>/dev/null || echo "")
      data=$(printf '%s' "$body" | jq -Rs '{body: .}')
    else
      data=$(cat "$G/mergestate-$issue.json" 2>/dev/null || echo '{}')
    fi
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
  "pr list")
    cat "$G/prlist.json" 2>/dev/null || echo "[]"
    ;;
  "pr checks")
    pr="$3"
    cat "$G/checks-$pr.json" 2>/dev/null || echo "[]"
    ;;
  "pr view")
    pr="$3"; shift 3
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "$json" = "title" ]; then
      cat "$G/title-$pr" 2>/dev/null
    else
      cat "$G/mergestate-$pr.json" 2>/dev/null \
        || printf '{"headRefName":"unknown","mergeStateStatus":"CLEAN"}'
    fi
    ;;
  "pr ready")
    touch "$G/readied-$3"
    ;;
  "pr merge")
    shift 2
    pr=""; subject="__nosubject__"; body="__nobody__"
    while [ $# -gt 0 ]; do
      case "$1" in
        --subject) subject="$2"; shift 2 ;;
        --body) body="$2"; shift 2 ;;
        --squash|--auto|--delete-branch) shift ;;
        *) pr="$1"; shift ;;
      esac
    done
    printf '%s' "$subject" > "$G/mergesubject-$pr"
    printf '%s' "$body" > "$G/mergebody-$pr"
    touch "$G/merged-$pr"
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' -- wie in runner-ts-s4-parity.test.sh: steuerbare Fehlschlaege
# ueber Marker-Dateien unter $GHSTATE_DIR.
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
case "${1:-}" in
  status)
    [ -e "$G/git-dirty" ] && printf ' M some/file.ts\n'
    exit 0
    ;;
  rev-parse) printf 'main\n'; exit 0 ;;
  fetch) [ -e "$G/git-fetch-fail" ] && exit 1; exit 0 ;;
  checkout)
    case "${2:-}" in
      -B) [ -e "$G/git-checkout-fail" ] && exit 1; exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  push) [ -e "$G/git-push-fail" ] && exit 1; exit 0 ;;
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

cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

chmod +x "$FAKEBIN/gh" "$FAKEBIN/git" "$FAKEBIN/claude"
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$REAL_REPO_DIR"
export STATUS_ISSUE=0
export QUEUE_ISSUE=0
export MAX_ROUNDS=1
# shellcheck source=/dev/null
source "$RUNNER"

# Wie in runner-ts-s4-parity.test.sh: STATE_DIR/GHSTATE_DIR je Pfad getrennt,
# damit auch gh-Seiteneffekte fuers Nachvergleichen erhalten bleiben.
compare_parity() {
  local desc="$1" setup="$2" fn="$3" ts_out ts_rc bash_out bash_rc
  shift 3

  STATE_DIR="$TMP/state-ts"; export STATE_DIR
  GHSTATE_DIR="$TMP/ghstate-ts"; export GHSTATE_DIR
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"; mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  "$setup"
  RUNNER_TS=1
  ts_out=$("$fn" "$@" 2>/dev/null); ts_rc=$?

  STATE_DIR="$TMP/state-bash"; export STATE_DIR
  GHSTATE_DIR="$TMP/ghstate-bash"; export GHSTATE_DIR
  rm -rf "$STATE_DIR" "$GHSTATE_DIR"; mkdir -p "$STATE_DIR" "$GHSTATE_DIR"
  "$setup"
  RUNNER_TS=0
  bash_out=$("$fn" "$@" 2>/dev/null); bash_rc=$?

  if [ "$ts_out" = "$bash_out" ] && [ "$ts_rc" = "$bash_rc" ]; then
    ok "$desc"
  else
    red "$desc (ts: out='$ts_out' rc=$ts_rc | bash: out='$bash_out' rc=$bash_rc)"
  fi
}

assert_file_eq() {   # $1 = Beschreibung, $2 = Pfad im TS-Zustand, $3 = Pfad im Bash-Zustand
  local a b
  a=$(cat "$2" 2>/dev/null || echo "<fehlt>")
  b=$(cat "$3" 2>/dev/null || echo "<fehlt>")
  if [ "$a" = "$b" ]; then ok "$1"; else red "$1 (ts='$a' bash='$b')"; fi
}

assert_file_presence_eq() {   # $1 = Beschreibung, $2 = Pfad im TS-Zustand, $3 = Pfad im Bash-Zustand
  local a b
  [ -e "$2" ] && a=present || a=absent
  [ -e "$3" ] && b=present || b=absent
  if [ "$a" = "$b" ]; then ok "$1 ($a)"; else red "$1 (ts=$a bash=$b)"; fi
}

setup_noop() { :; }

# ==============================================================================
# waiting_issues / parked_issues
# ==============================================================================
setup_waiting() { printf '[{"number":12},{"number":47}]' > "$GHSTATE_DIR/list-needs-input.json"; }
compare_parity "waiting_issues: reicht die Liste durch" setup_waiting waiting_issues
compare_parity "waiting_issues: leer ohne Treffer" setup_noop waiting_issues

setup_parked() { printf '[{"number":61}]' > "$GHSTATE_DIR/list-parked.json"; }
compare_parity "parked_issues: reicht die Liste durch" setup_parked parked_issues

# ==============================================================================
# park_issue -- kein eigener stdout-Vertrag, ueber gh-Seiteneffekt vergleichen.
# ==============================================================================
compare_parity "park_issue: kein eigener stdout" setup_noop park_issue 50
assert_file_eq "park_issue: applied-50 stimmt überein" \
  "$TMP/ghstate-ts/applied-50" "$TMP/ghstate-bash/applied-50"

# ==============================================================================
# queue_snapshot
# ==============================================================================
setup_snapshot() {
  printf '[{"number":1,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]' \
    > "$GHSTATE_DIR/queue-snapshot.json"
}
compare_parity "queue_snapshot: parst inkl. createdAt" setup_snapshot queue_snapshot
compare_parity "queue_snapshot: leeres Array ohne Fixture" setup_noop queue_snapshot

# ==============================================================================
# queue_body
# ==============================================================================
compare_parity "queue_body: leer ohne QUEUE_ISSUE" setup_noop queue_body

setup_body() { printf '#10\n#20' > "$GHSTATE_DIR/body-92"; }
QUEUE_ISSUE_BACKUP="$QUEUE_ISSUE"
QUEUE_ISSUE=92
compare_parity "queue_body: holt den Body über gh issue view" setup_body queue_body
QUEUE_ISSUE="$QUEUE_ISSUE_BACKUP"

# ==============================================================================
# self_heal_park
# ==============================================================================
compare_parity "self_heal_park: parkt in-progress+needs-input, behält needs-input" setup_noop \
  self_heal_park '[{"number":50,"labels":[{"name":"in-progress"},{"name":"needs-input"}],"createdAt":"2024-01-01T00:00:00Z"},{"number":70,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]'
assert_file_eq "self_heal_park: applied-50 stimmt überein" \
  "$TMP/ghstate-ts/applied-50" "$TMP/ghstate-bash/applied-50"

compare_parity "self_heal_park: nichts zu parken -> unveränderter Schnappschuss" setup_noop \
  self_heal_park '[{"number":60,"labels":[{"name":"in-progress"}],"createdAt":"2024-01-01T00:00:00Z"}]'

# ==============================================================================
# pick_ticket
# ==============================================================================
compare_parity "pick_ticket: Sicherheitsnetz -> blocked" setup_noop pick_ticket \
  '[{"number":50,"labels":[{"name":"in-progress"},{"name":"needs-input"}],"createdAt":"2024-01-01T00:00:00Z"}]' ""

compare_parity "pick_ticket: laufendes Ticket -> resume, keine Mutation" setup_noop pick_ticket \
  '[{"number":50,"labels":[{"name":"in-progress"}],"createdAt":"2024-01-01T00:00:00Z"}]' ""

compare_parity "pick_ticket: Resume eines geparkten Tickets" setup_noop pick_ticket \
  '[{"number":50,"labels":[{"name":"parked"}],"createdAt":"2024-01-01T00:00:00Z"}]' ""
assert_file_eq "pick_ticket: applied-50 (parked->in-progress) stimmt überein" \
  "$TMP/ghstate-ts/applied-50" "$TMP/ghstate-bash/applied-50"

compare_parity "pick_ticket: Prioritäts-Queue schlägt Label-Reihenfolge" setup_noop pick_ticket \
  '[{"number":99,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"},{"number":10,"labels":[{"name":"needs-plan"}],"createdAt":"2024-02-01T00:00:00Z"}]' \
  "#10, #99"

setup_pick_session() { printf 'sess-abc123' > "$STATE_DIR/session-47"; }
compare_parity "pick_ticket: needs-research mit bestehender Session -> resume" setup_pick_session pick_ticket \
  '[{"number":47,"labels":[{"name":"needs-research"}],"createdAt":"2024-01-01T00:00:00Z"}]' ""

compare_parity "pick_ticket: ready-Fallback -> start, Mutation" setup_noop pick_ticket \
  '[{"number":48,"labels":[{"name":"ready"}],"createdAt":"2024-01-01T00:00:00Z"}]' ""
assert_file_eq "pick_ticket: applied-48 (ready->in-progress) stimmt überein" \
  "$TMP/ghstate-ts/applied-48" "$TMP/ghstate-bash/applied-48"

compare_parity "pick_ticket: nichts wählbar -> none" setup_noop pick_ticket '[]' ""

# ==============================================================================
# watch_running_issue
# ==============================================================================
setup_watch_pending() {
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"pending","name":"e2e"}]' \
    > "$GHSTATE_DIR/checks-601.json"
}
compare_parity "watch_running_issue: pending" setup_watch_pending watch_running_issue 601 601

setup_watch_success() {
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-602.json"
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"CLEAN"}' > "$GHSTATE_DIR/mergestate-602.json"
  printf 'fix(runner): x — Closes #602' > "$GHSTATE_DIR/title-602"
}
compare_parity "watch_running_issue: success -> merged" setup_watch_success watch_running_issue 602 602
assert_file_presence_eq "watch_running_issue: PR #602 in beiden Pfaden gemerged" \
  "$TMP/ghstate-ts/merged-602" "$TMP/ghstate-bash/merged-602"

setup_watch_failing_protected() {
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"protected-paths"}]' \
    > "$GHSTATE_DIR/checks-603.json"
}
compare_parity "watch_running_issue: failing nur protected-paths -> needs-input-protected" \
  setup_watch_failing_protected watch_running_issue 603 603
assert_file_eq "watch_running_issue: applied-603 (needs-input) stimmt überein" \
  "$TMP/ghstate-ts/applied-603" "$TMP/ghstate-bash/applied-603"

setup_watch_failing_other() {
  printf '[{"bucket":"fail","name":"e2e","description":"2 tests failed","link":"https://x/actions/runs/1/job/1"}]' \
    > "$GHSTATE_DIR/checks-604.json"
}
compare_parity "watch_running_issue: failing über protected-paths hinaus -> build-fix" \
  setup_watch_failing_other watch_running_issue 604 604

setup_watch_behind_caughtup() {
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-605.json"
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"BEHIND"}' > "$GHSTATE_DIR/mergestate-605.json"
}
compare_parity "watch_running_issue: behind, sauber nachgezogen -> caught-up" \
  setup_watch_behind_caughtup watch_running_issue 605 605

setup_watch_behind_conflict() {
  setup_watch_behind_caughtup
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-606.json"
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"BEHIND"}' > "$GHSTATE_DIR/mergestate-606.json"
  touch "$GHSTATE_DIR/git-merge-conflict"
}
compare_parity "watch_running_issue: behind, Merge-Konflikt -> build-fix" \
  setup_watch_behind_conflict watch_running_issue 606 606

# ==============================================================================
# watch_parked_issues
# ==============================================================================
setup_watch_parked_promote() {
  printf '[{"number":709,"headRefName":"fix/709-x","title":"y"}]' > "$GHSTATE_DIR/prlist.json"
  printf '[{"bucket":"fail","name":"e2e"}]' > "$GHSTATE_DIR/checks-709.json"
  printf '{"headRefName":"fix/709-x","mergeStateStatus":"CLEAN"}' > "$GHSTATE_DIR/mergestate-709.json"
}
compare_parity "watch_parked_issues: rote Checks, WIP frei -> entparkt" \
  setup_watch_parked_promote watch_parked_issues \
  '[{"number":709,"createdAt":"2024-01-01T00:00:00Z","hasNeedsInput":false}]' "1"
assert_file_eq "watch_parked_issues: applied-709 (parked->in-progress) stimmt überein" \
  "$TMP/ghstate-ts/applied-709" "$TMP/ghstate-bash/applied-709"

setup_watch_parked_release() {
  printf '[{"number":710,"headRefName":"fix/710-x","title":"z"}]' > "$GHSTATE_DIR/prlist.json"
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-710.json"
  printf '{"headRefName":"fix/710-x","mergeStateStatus":"CLEAN"}' > "$GHSTATE_DIR/mergestate-710.json"
  printf 'fix(runner): z — Closes #710' > "$GHSTATE_DIR/title-710"
}
compare_parity "watch_parked_issues: CI grün -> freigegeben" \
  setup_watch_parked_release watch_parked_issues \
  '[{"number":710,"createdAt":"2024-01-01T00:00:00Z","hasNeedsInput":true}]' ""
assert_file_presence_eq "watch_parked_issues: PR #710 in beiden Pfaden gemerged" \
  "$TMP/ghstate-ts/merged-710" "$TMP/ghstate-bash/merged-710"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle TS/Bash-Paritätstests (S5) grün."
else
  red "Mindestens ein TS/Bash-Paritätstest (S5) ist rot (siehe oben)."
fi
exit $FAIL
