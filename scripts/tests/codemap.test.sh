#!/usr/bin/env bash
# Tests für scripts/check-codemap.sh (issue #445).
# Reine Bash-Assertions gegen ein Wegwerf-Fixture, kein echter Repo-Zustand
# nötig — CODEMAP_FILE ist env-überschreibbar genau dafür.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-codemap.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

assert_exit() {   # $1 = beschreibung, $2 = erwarteter exit-code, $3.. = kommando
  local desc="$1" expected="$2"; shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [ "$actual" -eq "$expected" ]; then
    ok "$desc"
  else
    red "$desc (erwartet exit $expected, bekommen $actual)"
  fi
}

# --- 1. Sauberes Fixture -> exit 0 ---------------------------------------
CASE1="$TMP/clean.md"
printf '# Code-Karte\n\n### src/app\n\n- `layout.tsx` — kurze Zeile\n' > "$CASE1"
assert_exit "AC1: sauberes Fixture bleibt grün" 0 \
  env CODEMAP_FILE="$CASE1" bash "$GUARD"

# --- 2. Zeile über 200 Zeichen -> exit 1 ----------------------------------
CASE2="$TMP/long-line.md"
LONG_SUFFIX=$(printf 'a%.0s' $(seq 1 250))
{
  echo "# Code-Karte"
  echo
  echo "- \`x.ts\` — $LONG_SUFFIX"
} > "$CASE2"
assert_exit "AC2: Zeile über 200 Zeichen schlägt an" 1 \
  env CODEMAP_FILE="$CASE2" bash "$GUARD"

# --- 3. Gesamtgröße über 25 KB -> exit 1 ----------------------------------
CASE3="$TMP/too-big.md"
: > "$CASE3"
for i in $(seq 1 700); do
  echo "- \`file-$i.ts\` — eine kurze, für sich genommen unauffällige Zeile" >> "$CASE3"
done
assert_exit "AC3: Gesamtgröße über 25 KB schlägt an" 1 \
  env CODEMAP_FILE="$CASE3" bash "$GUARD"

# --- 4. Fehlende Datei -> exit 1 ------------------------------------------
assert_exit "AC4: fehlende Datei schlägt an, statt still durchzulaufen" 1 \
  env CODEMAP_FILE="$TMP/does-not-exist.md" bash "$GUARD"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Codemap-Guard-Tests grün."
else
  red "Mindestens ein Codemap-Guard-Test ist rot (siehe oben)."
fi
exit $FAIL
