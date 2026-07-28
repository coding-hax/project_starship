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

# --- 4. Abschnitt 2 (count_tests): eingerückter Vitest-Test verschwindet ------
# git grep -E kennt \s nicht (POSIX-ERE) -- ohne [[:space:]] zählt der Wächter
# eingerückte it()/test()-Zeilen (Vitest, immer in describe()-Blöcken) gar
# nicht mit. Dieser Fall belegt, dass das Löschen einer ganzen Vitest-Datei
# den Wächter rot werden lässt -- vor dem Fix blieb er hier grün (0 -> 0),
# weil die einzige Testzeile nie mitgezählt wurde (Issue #274).
REPO4="$TMP/case4"
mkdir -p "$REPO4/src/features" "$REPO4/tests"
git -C "$REPO4" init -q -b main
git -C "$REPO4" config user.email test@example.invalid
git -C "$REPO4" config user.name test
cat > "$REPO4/tests/base.test.ts" <<'EOF'
describe('feature', () => {
  it('does the thing', () => {});
});
EOF
git -C "$REPO4" add -A
git -C "$REPO4" commit -q -m base
BASE4=$(git -C "$REPO4" rev-parse HEAD)
rm "$REPO4/tests/base.test.ts"
git -C "$REPO4" add -A
git -C "$REPO4" commit -q -m "delete vitest file"
assert_exit "AC4: gelöschte Vitest-Datei (eingerückter it()) macht den Wächter rot" 1 \
  bash -c "cd '$REPO4' && bash '$GUARD' '$BASE4'"

# --- 5. Abschnitt 2 (Testanzahl): 'tests-exempt' gilt jetzt auch hier ---------
# Issue #303: Regel 2 kannte das Label bisher nicht -- ein PR, der bewusst
# einen toten Zweig samt Tests entfernt, blieb ohne Ausweg rot. Jetzt zählt
# 'tests-exempt' hier genauso wie in Abschnitt 3.
REPO5="$TMP/case5"
new_repo "$REPO5"
BASE5=$(git -C "$REPO5" rev-parse HEAD)
rm "$REPO5/tests/base.test.ts"
git -C "$REPO5" add -A
git -C "$REPO5" commit -q -m "remove obsolete test, code unchanged"
assert_exit "AC5a: gesunkene Testanzahl ohne Exempt-Flag schlägt an" 1 \
  bash -c "cd '$REPO5' && bash '$GUARD' '$BASE5'"
assert_exit "AC5b: dieselbe Änderung mit TESTS_EXEMPT ist grün" 0 \
  bash -c "cd '$REPO5' && bash '$GUARD' '$BASE5' 1"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Test-Integrity-Tests grün."
else
  red "Mindestens ein Test-Integrity-Test ist rot (siehe oben)."
fi
exit $FAIL
