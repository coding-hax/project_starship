#!/usr/bin/env bash
# Tests für scripts/check-test-integrity.sh Abschnitt 3 — das Ausnahme-Gate
# (Issue #58, Phase B). Reine Bash-Assertions gegen ein Wegwerf-Git-Repo, weil
# das Script `git diff "$BASE"...HEAD` braucht (Muster wie
# scripts/tests/escalation.test.sh, aber ohne gh/git-Stubs — hier ist ein
# echtes Repo billiger als git zu stubben).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-test-integrity.sh"

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

new_repo() {   # $1 = zielpfad. Legt ein frisches Git-Repo mit einem Basis-Commit an.
  local repo="$1"
  mkdir -p "$repo/src/features" "$repo/tests"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name test
  echo 'export const foo = 1;' > "$repo/src/features/foo.ts"
  printf "test('base', () => {});\n" > "$repo/tests/base.test.ts"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m base
}

# --- 1. Quelldatei ohne Test geändert, ohne Exempt-Flag -> exit 1 -------------
REPO1="$TMP/case1"
new_repo "$REPO1"
BASE1=$(git -C "$REPO1" rev-parse HEAD)
echo 'export const foo = 2;' > "$REPO1/src/features/foo.ts"
git -C "$REPO1" add -A
git -C "$REPO1" commit -q -m "change without test"
assert_exit "AC1: Quelländerung ohne Test schlägt ohne Exempt an" 1 \
  bash -c "cd '$REPO1' && bash '$GUARD' '$BASE1'"

# --- 2. Dieselbe Änderung mit Exempt-Flag -> exit 0 ----------------------------
assert_exit "AC2: dieselbe Änderung mit TESTS_EXEMPT ist grün" 0 \
  bash -c "cd '$REPO1' && bash '$GUARD' '$BASE1' 1"

# --- 3. Nur .d.ts geändert, ohne Test, ohne Exempt -> exit 0 (Verengung) ------
REPO3="$TMP/case3"
new_repo "$REPO3"
BASE3=$(git -C "$REPO3" rev-parse HEAD)
echo 'export type Foo = number;' > "$REPO3/src/features/foo.d.ts"
git -C "$REPO3" add -A
git -C "$REPO3" commit -q -m "type-only change"
assert_exit "AC3: .d.ts-only-Änderung braucht keinen Test" 0 \
  bash -c "cd '$REPO3' && bash '$GUARD' '$BASE3'"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Test-Integrity-Tests grün."
else
  red "Mindestens ein Test-Integrity-Test ist rot (siehe oben)."
fi
exit $FAIL
