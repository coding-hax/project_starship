#!/usr/bin/env bash
# Tests für das Label 'opus-boost' (ADR-0007, Issue #136): hebt den
# Opus-Tagesdeckel je Ticket auf, ohne den Tageszähler zu nullen. Reine
# Bash-Assertions, kein bats -- Harness 1:1 wie escalation.test.sh.
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
# Wie escalation.test.sh, zusaetzlich: 'issue comment' zaehlt in
# commentcount-<nr> hoch (Grundlage fuer den Dedup-Test T6).
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
        --title|--body)
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
    cf="$G/commentcount-$issue"
    echo $(( $(cat "$cf" 2>/dev/null || echo 0) + 1 )) > "$cf"
    ;;
  "issue list")
    cat "$G/wip.json" 2>/dev/null || echo "[]"
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' ---------------------------------------------------------------
cat > "$FAKEBIN/git" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
if [ "${1:-}" = "ls-remote" ] && [ "${2:-}" = "--heads" ]; then
  shift 3   # ls-remote --heads origin
  for pat in "$@"; do
    num=$(echo "$pat" | grep -oE '[0-9]+' | head -1)
    f="$G/tip-$num"
    if [ -s "$f" ]; then
      printf '%s\trefs/heads/%s\n' "$(cat "$f")" "$pat"
      break
    fi
  done
fi
exit 0
STUB

# --- Stub 'claude' -------------------------------------------------------------
cat > "$FAKEBIN/claude" <<'STUB'
#!/usr/bin/env bash
case "${CLAUDE_STUB_MODE:-success}" in
  limit)
    printf '%s' '{"api_error_status":429,"result":"Session limit \xC2\xB7 resets 11:59pm (Europe/Berlin)"}'
    exit 1
    ;;
  *)
    printf '%s' '{"session_id":"stub","result":"ok"}'
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

setup_issue() {   # $1 = Issue-Nr, $2... = zusätzliche Labels
  local issue="$1"; shift
  local extra_json="" l
  : > "$GHSTATE_DIR/labels-$issue"
  echo "in-progress" >> "$GHSTATE_DIR/labels-$issue"
  for l in "$@"; do
    echo "$l" >> "$GHSTATE_DIR/labels-$issue"
    extra_json="${extra_json},{\"name\":\"$l\"}"
  done
  printf '[{"number":%s,"labels":[{"name":"in-progress"}%s]}]' "$issue" "$extra_json" \
    > "$GHSTATE_DIR/wip.json"
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

assert_file_absent() {
  if [ ! -e "$2" ]; then
    ok "$1"
  else
    red "$1 (Datei existiert noch: $2)"
  fi
}

assert_file_present() {
  if [ -e "$2" ]; then
    ok "$1"
  else
    red "$1 (Datei fehlt: $2)"
  fi
}

# ==============================================================================
# T1 -- Deckel-Bypass mit opus-boost, ohne Boost greift der Deckel unveraendert
# ==============================================================================
reset_state
ISSUE=201
echo 2 > "$STATE_DIR/opus-build-$(date +%Y%m%d)-$ISSUE"
if opus_build_cap_reached "$ISSUE" "opus-boost in-progress"; then
  red "T1: opus-boost umgeht den Deckel bei Zähler=2 (rc sollte 1 sein)"
else
  ok "T1: opus-boost umgeht den Deckel bei Zähler=2"
fi
if opus_build_cap_reached "$ISSUE" "in-progress"; then
  ok "T1: ohne Boost greift der Deckel bei Zähler=2 weiter"
else
  red "T1: ohne Boost greift der Deckel bei Zähler=2 weiter (rc sollte 0 sein)"
fi

# ==============================================================================
# T2 -- Deckel unveraendert ohne Label
# ==============================================================================
reset_state
ISSUE=202
echo 1 > "$STATE_DIR/opus-build-$(date +%Y%m%d)-$ISSUE"
if opus_build_cap_reached "$ISSUE" "in-progress"; then
  red "T2: Zähler=1 ohne Boost -> Deckel noch nicht erreicht"
else
  ok "T2: Zähler=1 ohne Boost -> Deckel noch nicht erreicht"
fi
echo 2 > "$STATE_DIR/opus-build-$(date +%Y%m%d)-$ISSUE"
if opus_build_cap_reached "$ISSUE" "in-progress"; then
  ok "T2: Zähler=2 ohne Boost -> Deckel erreicht"
else
  red "T2: Zähler=2 ohne Boost -> Deckel erreicht (rc sollte 0 sein)"
fi

# ==============================================================================
# T3 -- Boost wird bei Nicht-Fortschritt verbraucht (nur bei MODEL=opus)
# ==============================================================================
reset_state
ISSUE=203
setup_issue "$ISSUE" "opus-boost"
RUN_ROLE=build LABELS="in-progress opus-boost" MODEL=opus BEFORE_TIP="sha-alt"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 22.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
# kein tip-203 -> branch_tip liefert leer -> "kein Fortschritt"
build_escalation_eval
T3_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$T3_LABELS" in
  *opus-boost*) red "T3: opus-boost wird bei Nicht-Fortschritt entfernt (Labels: $T3_LABELS)" ;;
  *) ok "T3: opus-boost wird bei Nicht-Fortschritt entfernt" ;;
esac

# ==============================================================================
# T4 -- Boost bleibt bei Fortschritt
# ==============================================================================
reset_state
ISSUE=204
setup_issue "$ISSUE" "opus-boost"
echo opus > "$STATE_DIR/tier-$ISSUE"
RUN_ROLE=build LABELS="in-progress opus-boost" MODEL=opus BEFORE_TIP="sha-alt"
echo "sha-neu" > "$GHSTATE_DIR/tip-$ISSUE"   # Branch hat sich bewegt
build_escalation_eval
T4_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$T4_LABELS" in
  *opus-boost*) ok "T4: opus-boost bleibt bei Fortschritt" ;;
  *) red "T4: opus-boost bleibt bei Fortschritt (Labels: $T4_LABELS)" ;;
esac
assert_eq "T4: Fortschritt setzt Stufe auf Default zurück" "sonnet" "$(tier_current "$ISSUE")"

# ==============================================================================
# T5 -- no-escalation gewinnt gegen opus-boost (die Bremse schlägt das Gaspedal)
# ==============================================================================
reset_state
ISSUE=205
setup_issue "$ISSUE" "no-escalation" "opus-boost"
RUN_ROLE=build LABELS="in-progress no-escalation opus-boost" MODEL=opus BEFORE_TIP="sha-alt"
printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 22.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
  > "$GHSTATE_DIR/lastcomment-$ISSUE"
build_escalation_eval
build_escalation_eval
build_escalation_eval
assert_file_absent "T5: no-escalation verhindert jeden tier_bump, auch mit opus-boost" "$STATE_DIR/tier-$ISSUE"
T5_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$T5_LABELS" in
  *opus-boost*) ok "T5: opus-boost bleibt unangetastet (inert) unter no-escalation" ;;
  *) red "T5: opus-boost bleibt unangetastet (inert) unter no-escalation (Labels: $T5_LABELS)" ;;
esac

# ==============================================================================
# T6 -- Meldung höchstens einmal je Ticket und Tag
# ==============================================================================
reset_state
ISSUE=206
setup_issue "$ISSUE"
echo opus > "$STATE_DIR/tier-$ISSUE"
TODAY=$(date +%Y%m%d)
echo 2 > "$STATE_DIR/opus-build-$TODAY-$ISSUE"
(
  CLAUDE_STUB_MODE=success
  export CLAUDE_STUB_MODE
  main
) >/dev/null 2>&1
(
  CLAUDE_STUB_MODE=success
  export CLAUDE_STUB_MODE
  main
) >/dev/null 2>&1
assert_eq "T6: Meldung geht genau einmal raus, trotz zweier Ticks" \
  "1" "$(cat "$GHSTATE_DIR/commentcount-$ISSUE" 2>/dev/null || echo 0)"
assert_file_present "T6: Stempeldatei für den heutigen Tag existiert" \
  "$STATE_DIR/opus-cap-msg-$TODAY-$ISSUE"
T6_LABELS=$(cat "$GHSTATE_DIR/labels-$ISSUE" 2>/dev/null | tr '\n' ' ')
case "$T6_LABELS" in
  *needs-input*) ok "T6: needs-input wird bei jedem Treffer gesetzt (idempotent)" ;;
  *) red "T6: needs-input wird bei jedem Treffer gesetzt (Labels: $T6_LABELS)" ;;
esac

# ==============================================================================
# T7 -- Meldung nennt opus-boost als Ausweg
# ==============================================================================
case "$(cat "$GHSTATE_DIR/lastcomment-$ISSUE" 2>/dev/null)" in
  *opus-boost*) ok "T7: Erschöpfungsmeldung nennt opus-boost als Ausweg" ;;
  *) red "T7: Erschöpfungsmeldung nennt opus-boost als Ausweg" ;;
esac

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle opus-boost-Tests grün."
else
  red "Mindestens ein opus-boost-Test ist rot (siehe oben)."
fi
exit $FAIL
