#!/usr/bin/env bash
# Tests für #200 (S3 von #184): stdout + Exit-Code der acht portierten
# Funktionen (sha1_of, tier_current/tier_bump/tier_reset, resume_allowed,
# blocker_sig, opus_build_cap_reached/opus_build_cap_reserve) müssen über
# ts_run (RUNNER_TS=1, echtes tsx/cli.ts) und über den Bash-Pfad (RUNNER_TS=0)
# IDENTISCH sein -- das ist AC1 wörtlich. build_escalation_eval hat keinen
# eigenen stdout-Vertrag (reine Seiteneffekte) -- hier vergleichen wir
# zusätzlich die resultierende Zustandsdatei zwischen beiden Pfaden.
#
# REPO_DIR zeigt wie bei der S2-Fixture auf das ECHTE Repo, damit ts_run ein
# echtes tsx + scripts/runner/cli.ts zu fassen bekommt. STATE_DIR zeigt dagegen
# NIE auf das echte .runner/ -- ein eigenes Wegwerf-Verzeichnis pro Lauf, vorab
# exportiert. claude-runner.sh respektiert seit #200 ein bereits gesetztes
# STATE_DIR (statt es bedingungslos aus REPO_DIR abzuleiten) und exportiert es
# seinerseits weiter, damit der von ts_run gestartete tsx-Kindprozess
# (scripts/runner/state.ts liest process.env.STATE_DIR) exakt dasselbe
# Verzeichnis sieht wie dieser Bash-Pfad. gh/git sind wie in
# scripts/tests/escalation.test.sh gestubbt, damit weder TS- noch Bash-Pfad
# echtes Netz sehen.
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
export GHSTATE_DIR="$TMP/ghstate"
mkdir -p "$GHSTATE_DIR"

# --- Stub 'gh' -- Teilmenge wie scripts/tests/escalation.test.sh ------------
cat > "$FAKEBIN/gh" <<'STUB'
#!/usr/bin/env bash
G="$GHSTATE_DIR"
mkdir -p "$G"

case "${1:-} ${2:-}" in
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
    ;;
  *) ;;
esac
exit 0
STUB

# --- Stub 'git' -- nur 'ls-remote --heads origin' für branch_tip() ---------
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

reset_ghstate() {
  rm -rf "$GHSTATE_DIR"
  mkdir -p "$GHSTATE_DIR"
}

# $1 = Beschreibung, $2 = Setup-Funktion (bereitet STATE_DIR/GHSTATE_DIR VOR
# JEDEM der beiden Läufe identisch vor), $3 = Funktionsname, Rest = Argumente.
# Setzt STATE_DIR je Pfad auf ein eigenes Wegwerf-Verzeichnis, damit ein Lauf
# den anderen nie kontaminiert -- $TMP/state-ts bzw. $TMP/state-bash bleiben
# danach fürs Nachvergleichen der Zustandsdateien erhalten (siehe
# assert_file_eq unten).
compare_parity() {
  local desc="$1" setup="$2" fn="$3" ts_out ts_rc bash_out bash_rc
  shift 3

  STATE_DIR="$TMP/state-ts"; export STATE_DIR
  rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"
  reset_ghstate
  "$setup"
  RUNNER_TS=1
  ts_out=$("$fn" "$@" 2>/dev/null); ts_rc=$?

  STATE_DIR="$TMP/state-bash"; export STATE_DIR
  rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"
  reset_ghstate
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

setup_noop() { :; }

TODAY=$(date +%Y%m%d)

# ==============================================================================
# sha1_of -- rein argumentbasiert.
# ==============================================================================
compare_parity "sha1_of: bekannter Text" setup_noop sha1_of "hello world"

# ==============================================================================
# tier_current
# ==============================================================================
setup_tier_default() { : > "$GHSTATE_DIR/labels-501"; }
compare_parity "tier_current: Default sonnet ohne Label/Datei" setup_tier_default tier_current 501

setup_tier_haiku() { printf 'model:haiku\n' > "$GHSTATE_DIR/labels-502"; }
compare_parity "tier_current: model:haiku-Label -> haiku" setup_tier_haiku tier_current 502

setup_tier_file() { echo opus > "$STATE_DIR/tier-503"; }
compare_parity "tier_current: bestehende tier-Datei gewinnt" setup_tier_file tier_current 503

# ==============================================================================
# tier_bump
# ==============================================================================
compare_parity "tier_bump: sonnet -> opus (frisch)" setup_noop tier_bump 601
assert_file_eq "tier_bump: tier-601 stimmt überein" "$TMP/state-ts/tier-601" "$TMP/state-bash/tier-601"
assert_file_eq "tier_bump: failcount-601 stimmt überein" "$TMP/state-ts/failcount-601" "$TMP/state-bash/failcount-601"

setup_tier_opus() { echo opus > "$STATE_DIR/tier-602"; }
compare_parity "tier_bump: bereits opus -> erschöpft" setup_tier_opus tier_bump 602

# ==============================================================================
# tier_reset
# ==============================================================================
setup_tier_full() {
  echo opus > "$STATE_DIR/tier-701"
  echo 2 > "$STATE_DIR/failcount-701"
  printf 'sig' > "$STATE_DIR/blocker-sig-701"
}
compare_parity "tier_reset: räumt alle vier Dateien" setup_tier_full tier_reset 701
assert_file_eq "tier_reset: tier-701 danach in beiden Pfaden weg" "$TMP/state-ts/tier-701" "$TMP/state-bash/tier-701"

# ==============================================================================
# resume_allowed
# ==============================================================================
compare_parity "resume_allowed: erster Aufruf erlaubt" setup_noop resume_allowed 802
assert_file_eq "resume_allowed: Zähler auf 1" "$TMP/state-ts/resume-count-802" "$TMP/state-bash/resume-count-802"

setup_resume_capped() { echo 2 > "$STATE_DIR/resume-count-801"; }
compare_parity "resume_allowed: 3. Aufruf kappt" setup_resume_capped resume_allowed 801
assert_file_eq "resume_allowed: Zähler nach Kappen auf 0" "$TMP/state-ts/resume-count-801" "$TMP/state-bash/resume-count-801"

# ==============================================================================
# blocker_sig
# ==============================================================================
setup_blocker_progress() {
  printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
    > "$GHSTATE_DIR/lastcomment-901"
}
compare_parity "blocker_sig: Fortschrittskommentar liefert Hash" setup_blocker_progress blocker_sig 901

setup_blocker_none() { printf '%s' "irgendein anderer Kommentar" > "$GHSTATE_DIR/lastcomment-902"; }
compare_parity "blocker_sig: kein Fortschrittskommentar -> leer" setup_blocker_none blocker_sig 902

# ==============================================================================
# opus_build_cap_reached / opus_build_cap_reserve
# ==============================================================================
setup_cap_boost() { echo 2 > "$STATE_DIR/opus-build-$TODAY-1001"; }
compare_parity "opus_build_cap_reached: opus-boost umgeht Deckel" setup_cap_boost opus_build_cap_reached 1001 "opus-boost"

setup_cap_reached() { echo 2 > "$STATE_DIR/opus-build-$TODAY-1002"; }
compare_parity "opus_build_cap_reached: Deckel bei 2 erreicht" setup_cap_reached opus_build_cap_reached 1002 ""

setup_reserve() { echo 1 > "$STATE_DIR/opus-build-$TODAY-1101"; }
compare_parity "opus_build_cap_reserve: zählt hoch" setup_reserve opus_build_cap_reserve 1101
assert_file_eq "opus_build_cap_reserve: Zählerstand stimmt" \
  "$TMP/state-ts/opus-build-$TODAY-1101" "$TMP/state-bash/opus-build-$TODAY-1101"

# ==============================================================================
# build_escalation_eval -- kein eigener stdout-Vertrag, Vergleich über den
# resultierenden Zustand.
# ==============================================================================
setup_esc_ac1() {
  : > "$GHSTATE_DIR/labels-1201"
  printf '%s' "## 🤖 Fortschritt (automatisch aktualisiert)

_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._" \
    > "$GHSTATE_DIR/lastcomment-1201"
}
ISSUE=1201 RUN_ROLE=build LABELS="" BEFORE_TIP="sha-alt"
compare_parity "build_escalation_eval: kein Fortschritt -> failcount=1" setup_esc_ac1 build_escalation_eval
assert_file_eq "build_escalation_eval: failcount-1201 stimmt überein" \
  "$TMP/state-ts/failcount-1201" "$TMP/state-bash/failcount-1201"

setup_esc_noesc() { : > "$GHSTATE_DIR/labels-1202"; }
ISSUE=1202 RUN_ROLE=build LABELS="no-escalation" BEFORE_TIP="sha-alt"
compare_parity "build_escalation_eval: no-escalation-Gate" setup_esc_noesc build_escalation_eval
assert_file_eq "build_escalation_eval: keine tier-1202-Datei bei no-escalation" \
  "$TMP/state-ts/tier-1202" "$TMP/state-bash/tier-1202"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle TS/Bash-Paritätstests (S3) grün."
else
  red "Mindestens ein TS/Bash-Paritätstest (S3) ist rot (siehe oben)."
fi
exit $FAIL
