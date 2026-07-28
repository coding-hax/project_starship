#!/usr/bin/env bash
# Fixture-Tests für Issue #257: run_round() darf einen round-plan-Fehlschlag
# mit beliebigem Exitcode ≠ 0 (oder Exit 0 mit Müll auf stdout) nicht mehr mit
# einem stillen `return ""` quittieren ("...line 154: return: : numeric
# argument required"). Reine Bash-Assertions, kein bats (keine neue
# Dependency). Sourct claude-runner.sh (Source-Guard verhindert, dass main()
# dabei losläuft) und überschreibt DANACH ts_run()/status() als Bash-Funktionen
# -- so wird der Fehlerausgang von round-plan direkt simuliert, ohne einen
# echten TS-Kern zu brauchen, und run_round() wird direkt aufgerufen (nicht
# main).
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
# Nur damit der command-v-Check beim Sourcen durchläuft -- run_round erreicht
# gh/claude im Fehlerpfad nie. jq bleibt echt (wird von run_round selbst UND
# von den Assertions unten gebraucht).
for tool in gh claude; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done
export PATH="$FAKEBIN:$PATH"

export REPO_DIR="$TMP/repo"
export SHARED_DIR="$TMP/shared"
mkdir -p "$REPO_DIR"
export STATUS_ISSUE=0
# shellcheck source=/dev/null
source "$RUNNER"

STATUS_LOG="$TMP/status.log"
# Überschreibt die echte status() (die gh bräuchte) -- fängt die Meldung ab.
status() {   # $1 = Titel, $2 = Emoji, $3 = Text
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$STATUS_LOG"
}

reset_state() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  : > "$STATUS_LOG"
}

assert_eq() {   # $1 = Beschreibung, $2 = erwartet, $3 = tatsächlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

assert_status_has_error() {   # $1 = Beschreibung
  if grep -q "🔴" "$STATUS_LOG" 2>/dev/null; then
    ok "$1"
  else
    red "$1 (keine 🔴-Zeile in status())"
  fi
}

assert_no_broken_return() {   # $1 = Beschreibung, $2 = stderr-Datei
  if grep -q "numeric argument required" "$2" 2>/dev/null; then
    red "$1 (stderr enthält noch 'numeric argument required')"
  else
    ok "$1"
  fi
}

# ==============================================================================
# T1 -- round-plan scheitert mit Exit != 0 (z. B. TS-Ausnahme) und liefert
# leeren stdout. Vorher: `return ""` bricht mit "numeric argument required"
# ab, KEINE status()-Meldung.
# ==============================================================================
reset_state
ts_run() { [ "$1" = "round-plan" ] && return 3; printf '{}'; return 0; }
err_out="$TMP/t1.err"
( run_round ) >/dev/null 2>"$err_out"
rc=$?
assert_eq "AC1/T1: run_round meldet Exit 1 bei round-plan-Exit != 0" "1" "$rc"
assert_status_has_error "AC1/T1: status() bekommt eine 🔴-Meldung"
assert_no_broken_return "AC1/T1: kein kaputter return-Abbruch mehr auf stderr" "$err_out"

# ==============================================================================
# T2 -- round-plan liefert Exit 0, aber Müll auf stdout (kein gültiges JSON).
# Vorher: jq scheitert still, `return ""` bricht ab, KEINE status()-Meldung.
# ==============================================================================
reset_state
ts_run() { [ "$1" = "round-plan" ] && { printf 'kaputt kein json'; return 0; }; printf '{}'; return 0; }
err_out="$TMP/t2.err"
( run_round ) >/dev/null 2>"$err_out"
rc=$?
assert_eq "AC2/T2: run_round meldet Exit 1 bei kaputtem JSON (Exit 0)" "1" "$rc"
assert_status_has_error "AC2/T2: status() bekommt eine 🔴-Meldung"
assert_no_broken_return "AC2/T2: kein kaputter return-Abbruch mehr auf stderr" "$err_out"

# ==============================================================================
# T3 -- Gegenprobe: Exit 127 bleibt bei genau EINER Meldung (die von ts_run
# selbst, wie im echten Code) -- run_round darf sie nicht verdoppeln.
# ==============================================================================
reset_state
ts_run() {
  if [ "$1" = "round-plan" ]; then
    status "TS-Kern ausgefallen" "🔴" "🔴 stub"
    return 127
  fi
  printf '{}'; return 0
}
( run_round ) >/dev/null 2>/dev/null
rc=$?
assert_eq "AC1/T3: Exit 127 bleibt bei Exit 1" "1" "$rc"
lines=$(wc -l < "$STATUS_LOG" | tr -d ' ')
assert_eq "AC1/T3: keine Doppelmeldung bei 127 (genau eine status()-Zeile)" "1" "$lines"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle round-plan-Guard-Tests grün."
else
  red "Mindestens ein round-plan-Guard-Test ist rot (siehe oben)."
fi
exit $FAIL
