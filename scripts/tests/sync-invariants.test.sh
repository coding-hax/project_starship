#!/usr/bin/env bash
# Tests für scripts/check-sync-invariants.sh (Issue #58, Phase A).
# Reine Bash-Assertions gegen einen Wegwerf-Fixture-Baum, kein echter Repo-Zustand
# nötig — SCAN_ROOT ist env-überschreibbar genau dafür.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-sync-invariants.sh"

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

# --- 1. Feature-Datei mit direktem fetch('/api/...') -> Fund, exit 1 ----------
FIXTURE1="$TMP/case1/src"
mkdir -p "$FIXTURE1/features/tasks"
cat > "$FIXTURE1/features/tasks/task-list.tsx" <<'EOF'
export async function loadTasks() {
  return fetch('/api/sync/push');
}
EOF
assert_exit "AC1: fetch(/api) in Feature-Code schlägt an" 1 \
  env SCAN_ROOT="$FIXTURE1" bash "$GUARD"

# --- 2. Sauberer Baum ohne /api-fetch -> exit 0 --------------------------------
FIXTURE2="$TMP/case2/src"
mkdir -p "$FIXTURE2/features/tasks"
cat > "$FIXTURE2/features/tasks/task-list.tsx" <<'EOF'
import { db } from '@/local/dexie';

export function loadTasks() {
  return db.records.toArray();
}
EOF
assert_exit "AC2: sauberer Baum bleibt grün" 0 \
  env SCAN_ROOT="$FIXTURE2" bash "$GUARD"

# --- 3. fetch('/api/...') unter local/ bzw. app/anmelden/ -> Ausschluss greift -
FIXTURE3="$TMP/case3/src"
mkdir -p "$FIXTURE3/local" "$FIXTURE3/app/anmelden"
cat > "$FIXTURE3/local/sync.ts" <<'EOF'
export async function push() {
  return fetch('/api/sync/push');
}
EOF
cat > "$FIXTURE3/app/anmelden/page.tsx" <<'EOF'
export async function login() {
  return fetch('/api/auth/login/options', { method: 'POST' });
}
EOF
assert_exit "AC3: local/ und app/anmelden/ sind ausgeschlossen" 0 \
  env SCAN_ROOT="$FIXTURE3" bash "$GUARD"

# ==============================================================================
echo
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Sync-Invarianten-Tests grün."
else
  red "Mindestens ein Sync-Invarianten-Test ist rot (siehe oben)."
fi
exit $FAIL
