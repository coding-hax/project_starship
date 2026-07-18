#!/usr/bin/env bash
# Hinweis-Check: Server-Migration berührt, aber Dexie-Version nicht gebumpt.
# Reine Beratung, kein Gate — additive Server-Spalten und server-only-Tabellen
# brauchen legitim keinen Dexie-Bump (siehe docs/WORKFLOW.md, Issue #59).
set -uo pipefail

BASE="${1:-origin/main}"

MIG=$(git diff --name-only "$BASE"...HEAD -- 'src/db/migrations/**' 'src/db/schema.ts' 2>/dev/null)
DEXIE=$(git diff "$BASE"...HEAD -- 'src/local/dexie.ts' 2>/dev/null | grep -E '^\+.*db\.version\(' || true)

if [ -n "$MIG" ] && [ -z "$DEXIE" ]; then
  echo "::warning::Server-Migration berührt, aber src/local/dexie.ts trägt keinen neuen db.version()-Bump. Bewusst bestätigen, dass das Client-Schema wirklich unberührt bleibt (docs/WORKFLOW.md, Migrationen)."
else
  echo "✓ Kein Hinweis nötig."
fi

exit 0
