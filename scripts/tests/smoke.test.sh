#!/usr/bin/env bash
# Tests für die Entscheidungslogik des Post-Deploy-Smoke (#56).
# Reine Bash-Assertions, kein bats — Muster wie escalation.test.sh, aber ohne
# gh/git-Stubs, weil smoke-decide.sh keine Seiteneffekte hat.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECIDE="$TEST_DIR/../smoke-decide.sh"

FAIL=0
red() { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$1"; }

assert_eq() {   # $1 = beschreibung, $2 = erwartet, $3 = tatsaechlich
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    red "$1 (erwartet '$2', bekommen '$3')"
  fi
}

decide() {
  EXPECTED_SHA="${1:-}" HEALTH_VERSION="${2:-}" HEALTH_OK="${3:-}" \
    HEALTH_STATUS="${4:-}" PLAYWRIGHT_RESULT="${5:-}" "$DECIDE"
}

assert_eq "Match + gesund + Playwright grün -> HEALTHY" \
  "HEALTHY" "$(decide sha1 sha1 true 200 pass)"

assert_eq "Match + 503 -> REVERT" \
  "REVERT" "$(decide sha1 sha1 false 503 pass)"

assert_eq "Match + Playwright rot -> REVERT" \
  "REVERT" "$(decide sha1 sha1 true 200 fail)"

assert_eq "Mismatch -> AMBIGUOUS, kein Revert" \
  "AMBIGUOUS" "$(decide sha1 sha-alt true 200 pass)"

assert_eq "Fehlende Version (leer, nach Retries) -> AMBIGUOUS, kein Revert" \
  "AMBIGUOUS" "$(decide sha1 "" false 0 fail)"

echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Smoke-Decide-Tests grün."
else
  red "Mindestens ein Smoke-Decide-Test ist rot (siehe oben)."
fi
exit $FAIL
