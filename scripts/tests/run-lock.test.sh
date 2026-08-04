#!/usr/bin/env bash
# Fixture-Tests für Issue #489: die Übernahme eines verwaisten Slot-Locks war
# nicht atomar (Doppel-rm/Doppel-mkdir, PID-Schreiben nach mkdir). Reine
# Bash-Assertions, kein bats. Sourct claude-runner.sh (Source-Guard verhindert,
# dass main() dabei losläuft) und ruft acquire_run_lock() direkt auf, gegen
# ein Wegwerf-STATE_DIR.
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
# Nur damit der command-v-Check beim Sourcen durchläuft -- acquire_run_lock
# erreicht gh/claude nie. jq bleibt echt.
for tool in gh claude; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
export SHARED_DIR="$TMP/shared"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# Wegwerf-STATE_DIR, explizit gesetzt -- ein von außen ererbtes STATE_DIR
# würde sonst das echte .runner/ treffen (bekannte Falle).
export STATE_DIR="$TMP/state"
mkdir -p "$STATE_DIR"
# shellcheck source=/dev/null
source "$RUNNER"

reset_state() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsächlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

# ==============================================================================
# T1 -- frischer Lock: kein Lockfile vorhanden.
# ==============================================================================
reset_state
LOCK="$STATE_DIR/lock"
acquire_run_lock "$LOCK" "$$"
rc=$?
assert_eq "T1: frisch -- acquire_run_lock liefert 0" "0" "$rc"
assert_eq "T1: frisch -- Lock enthält eigene PID" "$$" "$(cat "$LOCK" 2>/dev/null)"
[ -s "$LOCK" ] && ok "T1/AK1: Lock ist nie leer" || red "T1/AK1: Lock ist leer"

# ==============================================================================
# T2 -- verwaister Lock (toter Besitzer) wird übernommen.
# ==============================================================================
reset_state
( sleep 0.1 ) & dead_pid=$!
wait "$dead_pid" 2>/dev/null
printf '%s\n' "$dead_pid" > "$LOCK"
acquire_run_lock "$LOCK" "$$"
rc=$?
assert_eq "T2/AK1: verwaist -- acquire_run_lock liefert 0" "0" "$rc"
assert_eq "T2/AK1: verwaist -- Lock trägt jetzt unsere PID" "$$" "$(cat "$LOCK" 2>/dev/null)"
[ -s "$LOCK" ] && ok "T2/AK1: Lock ist nie leer" || red "T2/AK1: Lock ist leer"

# ==============================================================================
# T3 -- lebender Besitzer wird nie verdrängt (AK3).
# ==============================================================================
reset_state
sleep 30 & live_pid=$!
printf '%s\n' "$live_pid" > "$LOCK"
acquire_run_lock "$LOCK" "$$"
rc=$?
assert_eq "T3/AK3: lebend -- acquire_run_lock liefert 1" "1" "$rc"
assert_eq "T3/AK3: lebend -- Lock bleibt beim Besitzer" "$live_pid" "$(cat "$LOCK" 2>/dev/null)"
kill "$live_pid" 2>/dev/null
wait "$live_pid" 2>/dev/null

# ==============================================================================
# T4/AK2 -- zwei gleichzeitige Übernahmen eines verwaisten Locks: genau eine
# gewinnt, der Lock trägt am Ende die PID des Gewinners.
# ==============================================================================
reset_state
( sleep 0.1 ) & dead_pid=$!
wait "$dead_pid" 2>/dev/null
printf '%s\n' "$dead_pid" > "$LOCK"

OUT_A="$TMP/out_a"; OUT_B="$TMP/out_b"
(
  acquire_run_lock "$LOCK" "1001"
  echo "$?" > "$OUT_A"
) &
pid_a=$!
(
  acquire_run_lock "$LOCK" "1002"
  echo "$?" > "$OUT_B"
) &
pid_b=$!
wait "$pid_a" "$pid_b"

rc_a=$(cat "$OUT_A"); rc_b=$(cat "$OUT_B")
winners=0
[ "$rc_a" = "0" ] && winners=$((winners + 1))
[ "$rc_b" = "0" ] && winners=$((winners + 1))
assert_eq "T4/AK2: genau ein Übernehmer gewinnt" "1" "$winners"

lock_content=$(cat "$LOCK" 2>/dev/null)
if [ "$rc_a" = "0" ]; then
  assert_eq "T4/AK2: Lock trägt die PID des Gewinners (A)" "1001" "$lock_content"
elif [ "$rc_b" = "0" ]; then
  assert_eq "T4/AK2: Lock trägt die PID des Gewinners (B)" "1002" "$lock_content"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle run-lock-Tests grün."
else
  red "Mindestens ein run-lock-Test ist rot (siehe oben)."
fi
exit $FAIL
