#!/usr/bin/env bash
# Tests für scripts/check-dexie-bump.sh (Issue #59).
# Baut echte Commits in einem Wegwerf-Repo, weil der Guard git diff gegen BASE
# rechnet — ein Fixture-Baum ohne Git-Historie reicht hier nicht.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-dexie-bump.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$TMP" || exit 1
git init --quiet -b main
git config user.email "test@example.com"
git config user.name "test"

mkdir -p src/db/migrations src/local
echo '{}' > src/db/schema.ts
echo "db.version(1).stores({});" > src/local/dexie.ts
touch src/db/migrations/.gitkeep
git add -A
git commit --quiet -m "base"

# --- 1. Server-Migration berührt, kein Dexie-Bump -> Warnung, exit 0 ----------
git checkout --quiet -b case1
echo "0001_initial.sql" > src/db/migrations/0001_initial.sql
git add -A
git commit --quiet -m "add migration"
OUT=$(bash "$GUARD" main)
CODE=$?
if [ "$CODE" -eq 0 ] && echo "$OUT" | grep -q '::warning::'; then
  ok "AC1: Migration ohne Dexie-Bump warnt, bleibt aber exit 0"
else
  red "AC1: erwartet Warnung + exit 0, bekommen exit=$CODE, out=$OUT"
fi
git checkout --quiet main
git branch -D case1 --quiet

# --- 2. Server-Migration berührt UND Dexie-Bump vorhanden -> keine Warnung ----
git checkout --quiet -b case2
echo "0001_initial.sql" > src/db/migrations/0001_initial.sql
echo "db.version(2).stores({ tasks: 'id' });" > src/local/dexie.ts
git add -A
git commit --quiet -m "add migration + dexie bump"
OUT=$(bash "$GUARD" main)
CODE=$?
if [ "$CODE" -eq 0 ] && ! echo "$OUT" | grep -q '::warning::'; then
  ok "AC2: Migration mit Dexie-Bump bleibt still"
else
  red "AC2: erwartet keine Warnung, bekommen exit=$CODE, out=$OUT"
fi
git checkout --quiet main
git branch -D case2 --quiet

# --- 3. Nur unrelated Datei geändert -> keine Warnung -------------------------
git checkout --quiet -b case3
mkdir -p src/features
echo "export const x = 1;" > src/features/unrelated.ts
git add -A
git commit --quiet -m "unrelated change"
OUT=$(bash "$GUARD" main)
CODE=$?
if [ "$CODE" -eq 0 ] && ! echo "$OUT" | grep -q '::warning::'; then
  ok "AC3: unrelated Änderung bleibt still"
else
  red "AC3: erwartet keine Warnung, bekommen exit=$CODE, out=$OUT"
fi

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Dexie-Bump-Hinweis-Tests grün."
else
  red "Mindestens ein Dexie-Bump-Hinweis-Test ist rot (siehe oben)."
fi
exit $FAIL
