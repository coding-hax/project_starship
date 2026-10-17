#!/usr/bin/env bash
# Tests für scripts/check-tenant-isolation.sh (#1200, ADR-0031).
# Reine Bash-Assertions gegen ein Wegwerf-Fixture, kein echter Repo-Zustand
# nötig — SCAN_ROOT/SCHEMA sind env-überschreibbar genau dafür.
#
# Ein Wächter, der nie rot wird, ist kein Wächter. Jede der drei Regeln bekommt
# deshalb beides: einen Baum, der sie verletzt, und einen, der sie einhält.
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$TEST_DIR/../check-tenant-isolation.sh"

FAIL=0
red()  { printf '\033[31m✗ %s\033[0m\n' "$1"; FAIL=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- Bausteine ---------------------------------------------------------------

clean_schema() {
  mkdir -p "$1/db"
  cat > "$1/db/schema.ts" <<'EOF'
export const syncColumns = { userId: 1, id: 2 };

export const tasks = pgTable(
  'tasks',
  { ...syncColumns, title: text('title') },
  (table) => [tenantPrimaryKey(table), index('tasks_updated_at_idx').on(table.updatedAt)],
);

export const sessions = pgTable(
  'sessions',
  { id: uuid('id').primaryKey(), tokenHash: text('token_hash') },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
);
EOF
}

guarded_route() {
  mkdir -p "$1/app/api/sync/push"
  cat > "$1/app/api/sync/push/route.ts" <<'EOF'
import { requireUser } from '@/auth/session';
import { db } from '@/db';
export async function POST() {
  const user = await requireUser();
  return db.select().from(tasks).where(eq(tasks.userId, user.userId));
}
EOF
}

run_guard() { env SCAN_ROOT="$1" SCHEMA="$1/db/schema.ts" bash "$GUARD" 2>&1; }

# --- 1. sauberer Baum: grün --------------------------------------------------

CLEAN="$TMP/clean/src"
mkdir -p "$CLEAN"
clean_schema "$CLEAN"
guarded_route "$CLEAN"

OUTPUT=$(run_guard "$CLEAN"); STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  ok "sauberer Baum: Wächter grün"
else
  echo "$OUTPUT"
  red "sauberer Baum müsste grün sein, ist aber rot"
fi

# --- 2. synchronisierte Tabelle ohne (user_id, id) ---------------------------

CASE="$TMP/nopk/src"
mkdir -p "$CASE"
clean_schema "$CASE"
guarded_route "$CASE"
cat >> "$CASE/db/schema.ts" <<'EOF'

export const habits = pgTable(
  'habits',
  { ...syncColumns, name: text('name') },
  (table) => [index('habits_updated_at_idx').on(table.updatedAt)],
);
EOF

OUTPUT=$(run_guard "$CASE"); STATUS=$?
if [ "$STATUS" -ne 0 ] && echo "$OUTPUT" | grep -q "tenantPrimaryKey" && echo "$OUTPUT" | grep -q "habits"; then
  ok "Tabelle mit syncColumns ohne tenantPrimaryKey: Wächter rot, nennt die Tabelle"
else
  echo "$OUTPUT"
  red "fehlender (user_id, id)-Primärschlüssel wurde nicht erkannt"
fi

# Eine Tabelle *ohne* syncColumns (sessions oben) darf dabei nicht anschlagen.
if ! echo "$OUTPUT" | grep -q "sessions"; then
  ok "nicht synchronisierte Tabelle wird nicht eingefordert"
else
  red "sessions trägt keine syncColumns und darf keinen tenantPrimaryKey brauchen"
fi

# --- 3. requireOwner / OWNER_USER_ID zurück ----------------------------------

for LEGACY in "requireOwner" "OWNER_USER_ID"; do
  CASE="$TMP/legacy-$LEGACY/src"
  mkdir -p "$CASE/auth"
  clean_schema "$CASE"
  guarded_route "$CASE"
  printf 'export const owner = %s;\n' "$LEGACY" > "$CASE/auth/old.ts"

  OUTPUT=$(run_guard "$CASE"); STATUS=$?
  if [ "$STATUS" -ne 0 ] && echo "$OUTPUT" | grep -q "requireOwner/OWNER_USER_ID"; then
    ok "$LEGACY wieder im Baum: Wächter rot"
  else
    echo "$OUTPUT"
    red "$LEGACY wurde nicht erkannt"
  fi
done

# --- 4. API-Route mit @/db, ohne Konto ---------------------------------------

CASE="$TMP/unguarded/src"
mkdir -p "$CASE/app/api/leak"
clean_schema "$CASE"
guarded_route "$CASE"
cat > "$CASE/app/api/leak/route.ts" <<'EOF'
import { db } from '@/db';
export async function GET() {
  return db.select().from(tasks);
}
EOF

OUTPUT=$(run_guard "$CASE"); STATUS=$?
if [ "$STATUS" -ne 0 ] && echo "$OUTPUT" | grep -q "app/api/leak/route.ts"; then
  ok "API-Route mit DB-Zugriff ohne Konto: Wächter rot, nennt die Datei"
else
  echo "$OUTPUT"
  red "ungeschützte API-Route wurde nicht erkannt"
fi

# --- 5. Helfer, der das Konto als Parameter bekommt, ist in Ordnung ----------

CASE="$TMP/helper/src"
mkdir -p "$CASE/app/api/sync/pull"
clean_schema "$CASE"
guarded_route "$CASE"
cat > "$CASE/app/api/sync/pull/read-changes-since.ts" <<'EOF'
import { db } from '@/db';
export async function readChangesSince(executor: unknown, since: number, userId: string) {
  return db.select().from(tasks).where(eq(tasks.userId, userId));
}
EOF

OUTPUT=$(run_guard "$CASE"); STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  ok "Helfer mit userId-Parameter: Wächter grün"
else
  echo "$OUTPUT"
  red "ein Helfer, der userId gereicht bekommt, darf nicht anschlagen"
fi

# --- 6. Die begründeten Ausnahmen bleiben offen ------------------------------

CASE="$TMP/allowed/src"
mkdir -p "$CASE/app/api/health" "$CASE/app/api/auth/login/verify"
clean_schema "$CASE"
guarded_route "$CASE"
cat > "$CASE/app/api/health/route.ts" <<'EOF'
import { db } from '@/db';
export async function GET() {
  return db.execute('select 1');
}
EOF
cat > "$CASE/app/api/auth/login/verify/route.ts" <<'EOF'
import { db } from '@/db';
export async function POST() {
  return db.select().from(credentials);
}
EOF

OUTPUT=$(run_guard "$CASE"); STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  ok "health und auth/login bleiben erlaubt (Sitzung entsteht dort erst)"
else
  echo "$OUTPUT"
  red "die begründeten Ausnahmen dürfen nicht anschlagen"
fi

exit $FAIL
