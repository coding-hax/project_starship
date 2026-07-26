#!/usr/bin/env bash
# Tests für #201 (S4 von #184): stdout + Exit-Code der zwoelf portierten
# PR-Zustandsfunktionen (pr_for_issue, pr_ci_state, pr_is_behind,
# pr_merge_state, pr_catch_up_behind, catchup_fail_reason/-escalated/-reset,
# pr_only_protected_paths_red, pr_squash_merge, reopen_falsely_closed_issues,
# pr_failure_summary) müssen über ts_run (RUNNER_TS=1, echtes tsx/cli.ts) und
# über den Bash-Pfad (RUNNER_TS=0) IDENTISCH sein -- AC1 wörtlich.
# pr_squash_merge/reopen_falsely_closed_issues haben keinen eigenen
# stdout-Vertrag (reine gh-Seiteneffekte) -- dort vergleichen wir die
# resultierenden GHSTATE-Marker-Dateien statt stdout.
#
# Gleiches Grundgeruest wie runner-ts-s3-parity.test.sh: REPO_DIR zeigt auf
# das ECHTE Repo (damit ts_run ein echtes tsx + cli.ts zu fassen bekommt),
# STATE_DIR UND GHSTATE_DIR zeigen dagegen je Pfad auf ein eigenes
# Wegwerf-Verzeichnis ($TMP/state-ts|state-bash, $TMP/ghstate-ts|ghstate-bash)
# -- so bleiben auch die gh-Seiteneffekte beider Pfade fuers Nachvergleichen
# erhalten, nicht nur der STATE_DIR-Zustand. gh/git sind wie in
# ci-watch.test.sh/squash-close-guard.test.sh gestubbt (Obermenge beider),
# damit weder TS- noch Bash-Pfad echtes Netz oder den echten Arbeitsbaum sehen.
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

# --- Stub 'gh' -- Obermenge aus ci-watch.test.sh + squash-close-guard.test.sh
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
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
  "issue view")
    issue="$3"; shift 3
    json=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json) json="$2"; shift 2 ;;
        -q) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "$json" = "state" ]; then
      cat "$G/state-$issue" 2>/dev/null || echo "OPEN"
    fi
    ;;
  "issue reopen")
    issue="$3"
    echo OPEN > "$G/state-$issue"
    touch "$G/reopened-$issue"
    ;;
  "issue comment")
    issue="$3"; shift 3
    body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s' "$body" > "$G/lastcomment-$issue"
    ;;
  "run view")
    printf 'log line 1\nlog line 2\n'
    ;;
  *) ;;
esac
exit 0
STUB
# Kein jq-Stub: reopen_falsely_closed_issues_bash() parst mit echtem jq
# (regex-capture) -- ein No-op-Stub liesse den Netz-Fall nie pruefen. jq ist
# lokal und auf den GitHub-Runnern ohnehin vorhanden.

# --- Stub 'git' -- wie in ci-watch.test.sh: steuerbare Fehlschlaege ueber
# Marker-Dateien unter $GHSTATE_DIR (git-dirty, git-fetch-fail,
# git-checkout-fail, git-push-fail, git-merge-conflict).
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
  fetch)
    [ -e "$G/git-fetch-fail" ] && exit 1
    exit 0
    ;;
  checkout)
    case "${2:-}" in
      -B) [ -e "$G/git-checkout-fail" ] && exit 1; exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  push)
    [ -e "$G/git-push-fail" ] && exit 1
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

# $1 = Beschreibung, $2 = Setup-Funktion (bereitet STATE_DIR/GHSTATE_DIR VOR
# JEDEM der beiden Läufe identisch vor), $3 = Funktionsname, Rest = Argumente.
# STATE_DIR UND GHSTATE_DIR zeigen je Pfad auf ein eigenes
# Wegwerf-Verzeichnis, das danach fürs Nachvergleichen erhalten bleibt
# ($TMP/state-ts|bash, $TMP/ghstate-ts|bash) -- ein Lauf kontaminiert den
# anderen nie.
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
  if [ "$a" = "$b" ]; then
    ok "$1"
  else
    red "$1 (ts='$a' bash='$b')"
  fi
}

assert_file_presence_eq() {   # $1 = Beschreibung, $2 = Pfad im TS-Zustand, $3 = Pfad im Bash-Zustand
  local a b
  [ -e "$2" ] && a=present || a=absent
  [ -e "$3" ] && b=present || b=absent
  if [ "$a" = "$b" ]; then
    ok "$1 ($a)"
  else
    red "$1 (ts=$a bash=$b)"
  fi
}

setup_noop() { :; }

# ==============================================================================
# pr_for_issue
# ==============================================================================
setup_prlist() {
  printf '[{"number":209,"headRefName":"feat/201-runner-ts-s4-pr-zustaende","title":"x"},{"number":99,"headRefName":"feat/999-irgendwas","title":"y"}]' \
    > "$GHSTATE_DIR/prlist.json"
}
compare_parity "pr_for_issue: findet ueber Branch-Konvention" setup_prlist pr_for_issue 201
compare_parity "pr_for_issue: kein Treffer -> leer" setup_noop pr_for_issue 555

# ==============================================================================
# pr_ci_state / pr_is_behind / pr_merge_state
# ==============================================================================
setup_pending() {
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"pending","name":"e2e"}]' \
    > "$GHSTATE_DIR/checks-501.json"
}
compare_parity "pr_ci_state: pending hat Vorrang vor failing" setup_pending pr_ci_state 501

setup_failing() {
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"e2e"}]' \
    > "$GHSTATE_DIR/checks-502.json"
}
compare_parity "pr_ci_state: failing" setup_failing pr_ci_state 502

setup_behind() {
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-503.json"
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"BEHIND"}' > "$GHSTATE_DIR/mergestate-503.json"
}
compare_parity "pr_ci_state: behind" setup_behind pr_ci_state 503
compare_parity "pr_is_behind: BEHIND -> true" setup_behind pr_is_behind 503
compare_parity "pr_merge_state: JSON-Passthrough" setup_behind pr_merge_state 503

setup_success() {
  printf '[{"bucket":"pass","name":"quality"}]' > "$GHSTATE_DIR/checks-504.json"
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"CLEAN"}' > "$GHSTATE_DIR/mergestate-504.json"
}
compare_parity "pr_ci_state: success" setup_success pr_ci_state 504

compare_parity "pr_ci_state: keine Checks -> pending" setup_noop pr_ci_state 505

# ==============================================================================
# pr_only_protected_paths_red
# ==============================================================================
setup_only_protected() {
  printf '[{"bucket":"pass","name":"quality"},{"bucket":"fail","name":"protected-paths"}]' \
    > "$GHSTATE_DIR/checks-506.json"
}
compare_parity "pr_only_protected_paths_red: nur protected-paths rot -> true" \
  setup_only_protected pr_only_protected_paths_red 506

setup_also_other_red() {
  printf '[{"bucket":"fail","name":"protected-paths"},{"bucket":"fail","name":"e2e"}]' \
    > "$GHSTATE_DIR/checks-507.json"
}
compare_parity "pr_only_protected_paths_red: zusaetzlich anderes rot -> false" \
  setup_also_other_red pr_only_protected_paths_red 507

# ==============================================================================
# pr_failure_summary
# ==============================================================================
setup_failure_summary() {
  printf '[{"bucket":"fail","name":"e2e","description":"2 tests failed","link":"https://x/actions/runs/999/job/1"},{"bucket":"fail","name":"protected-paths","description":"Approval missing"}]' \
    > "$GHSTATE_DIR/checks-508.json"
}
compare_parity "pr_failure_summary: nennt Job + Log, ohne protected-paths" \
  setup_failure_summary pr_failure_summary 508

# ==============================================================================
# pr_catch_up_behind -- alle sechs Exitcodes 0-5
# ==============================================================================
setup_catchup_ok() {
  printf '{"headRefName":"fix/1-x","mergeStateStatus":"BEHIND"}' > "$GHSTATE_DIR/mergestate-701.json"
}
compare_parity "pr_catch_up_behind: sauber nachgezogen (rc 0)" setup_catchup_ok pr_catch_up_behind 701

setup_catchup_dirty() {
  setup_catchup_ok
  touch "$GHSTATE_DIR/git-dirty"
}
compare_parity "pr_catch_up_behind: unsauberer Arbeitsbaum (rc 2)" setup_catchup_dirty pr_catch_up_behind 701

setup_catchup_conflict() {
  setup_catchup_ok
  touch "$GHSTATE_DIR/git-merge-conflict"
}
compare_parity "pr_catch_up_behind: Merge-Konflikt (rc 1)" setup_catchup_conflict pr_catch_up_behind 701

setup_catchup_fetch_fail() {
  setup_catchup_ok
  touch "$GHSTATE_DIR/git-fetch-fail"
}
compare_parity "pr_catch_up_behind: fetch fehlgeschlagen (rc 3)" setup_catchup_fetch_fail pr_catch_up_behind 701

setup_catchup_checkout_fail() {
  setup_catchup_ok
  touch "$GHSTATE_DIR/git-checkout-fail"
}
compare_parity "pr_catch_up_behind: checkout fehlgeschlagen (rc 4)" setup_catchup_checkout_fail pr_catch_up_behind 701

setup_catchup_push_fail() {
  setup_catchup_ok
  touch "$GHSTATE_DIR/git-push-fail"
}
compare_parity "pr_catch_up_behind: push fehlgeschlagen (rc 5)" setup_catchup_push_fail pr_catch_up_behind 701

compare_parity "pr_catch_up_behind: PR-Metadaten nicht lesbar (rc 3)" setup_noop pr_catch_up_behind 999

# ==============================================================================
# catchup_fail_reason / catchup_fail_escalated / catchup_fail_reset
# ==============================================================================
compare_parity "catchup_fail_reason: 2 -> unsauberer Arbeitsbaum" setup_noop catchup_fail_reason 2
compare_parity "catchup_fail_reason: unbekannter Code" setup_noop catchup_fail_reason 42

compare_parity "catchup_fail_escalated: erste Runde noch nicht eskaliert" \
  setup_noop catchup_fail_escalated 801 "unsauberer Arbeitsbaum"
assert_file_eq "catchup_fail_escalated: catchup-fail-801 stimmt überein" \
  "$TMP/state-ts/catchup-fail-801" "$TMP/state-bash/catchup-fail-801"

setup_catchup_escalated_ready() {
  printf 'unsauberer Arbeitsbaum\n2\n' > "$STATE_DIR/catchup-fail-802"
}
compare_parity "catchup_fail_escalated: dritte Runde eskaliert" \
  setup_catchup_escalated_ready catchup_fail_escalated 802 "unsauberer Arbeitsbaum"

setup_catchup_reset_ready() {
  printf 'unsauberer Arbeitsbaum\n2\n' > "$STATE_DIR/catchup-fail-803"
}
compare_parity "catchup_fail_reset: raeumt die Zaehldatei weg" \
  setup_catchup_reset_ready catchup_fail_reset 803
assert_file_presence_eq "catchup_fail_reset: catchup-fail-803 danach in beiden Pfaden weg" \
  "$TMP/state-ts/catchup-fail-803" "$TMP/state-bash/catchup-fail-803"

# ==============================================================================
# pr_squash_merge -- kein eigener stdout-Vertrag, Vergleich ueber die
# gh-Seiteneffekte (Subject/Body/Merge-Marker).
# ==============================================================================
setup_squash_with_title() {
  printf 'fix(runner): needs-input bei geschützten Pfaden — Closes #163' > "$GHSTATE_DIR/title-901"
}
compare_parity "pr_squash_merge: kein eigener stdout" setup_squash_with_title pr_squash_merge 901
assert_file_eq "pr_squash_merge: Subject stimmt überein" \
  "$TMP/ghstate-ts/mergesubject-901" "$TMP/ghstate-bash/mergesubject-901"
assert_file_eq "pr_squash_merge: Body stimmt überein (leer)" \
  "$TMP/ghstate-ts/mergebody-901" "$TMP/ghstate-bash/mergebody-901"
assert_file_presence_eq "pr_squash_merge: Merge-Marker in beiden Pfaden gesetzt" \
  "$TMP/ghstate-ts/merged-901" "$TMP/ghstate-bash/merged-901"

compare_parity "pr_squash_merge: ohne Titel" setup_noop pr_squash_merge 902
assert_file_eq "pr_squash_merge: kein --subject ohne Titel, beide Pfade gleich" \
  "$TMP/ghstate-ts/mergesubject-902" "$TMP/ghstate-bash/mergesubject-902"

# ==============================================================================
# reopen_falsely_closed_issues -- ebenfalls reiner Seiteneffekt.
# ==============================================================================
setup_reopen() {
  printf '[{"number":166,"headRefName":"x","title":"fix(runner): needs-input — Closes #163"},{"number":170,"headRefName":"y","title":"feat(weather): Feinschliff — Closes #155"}]' \
    > "$GHSTATE_DIR/prlist.json"
  echo CLOSED > "$GHSTATE_DIR/state-163"
  echo OPEN > "$GHSTATE_DIR/state-155"
}
compare_parity "reopen_falsely_closed_issues: kein eigener stdout" setup_reopen reopen_falsely_closed_issues
assert_file_presence_eq "reopen_falsely_closed_issues: #163 in beiden Pfaden wieder geoeffnet" \
  "$TMP/ghstate-ts/reopened-163" "$TMP/ghstate-bash/reopened-163"
assert_file_presence_eq "reopen_falsely_closed_issues: #155 bleibt in beiden Pfaden unangetastet" \
  "$TMP/ghstate-ts/reopened-155" "$TMP/ghstate-bash/reopened-155"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle TS/Bash-Paritätstests (S4) grün."
else
  red "Mindestens ein TS/Bash-Paritätstest (S4) ist rot (siehe oben)."
fi
exit $FAIL
