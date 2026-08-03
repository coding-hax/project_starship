import { asc, gt } from 'drizzle-orm';
import { db } from '@/db';
import { SYNC_REGISTRY } from '@/db/sync-tables';
import { SYNC_TABLES, type ChangeRow } from '@/local/types';

/**
 * One query per table (below), so every read but the first must see a snapshot
 * from before any of them started — otherwise a push that commits between two of
 * these reads leaves a gap: a row from the earlier table never appears in this or
 * any future pull, because the cursor already moved past its `sync_seq` (fund
 * F1 / #472). Factored out of route.ts — not just for the testable seam (a test
 * can run this against a plain (autocommit) executor and reproduce the gap, then
 * against a `tx` and show it is gone) but because Next.js route files may only
 * export the handful of recognized route fields (`GET`, `POST`, …); any other
 * export fails the build ("is not a valid Route export field").
 */
export async function readChangesSince(
  executor: Pick<typeof db, 'select'>,
  since: number,
): Promise<ChangeRow[]> {
  const changes: ChangeRow[] = [];

  for (const name of SYNC_TABLES) {
    const entry = SYNC_REGISTRY[name] as {
      table: typeof SYNC_REGISTRY.tasks.table;
      writable: readonly string[];
      readable?: readonly string[];
    };
    const table = entry.table;
    // A read-only table (ADR-0011) has no writable fields to fall back to — pull
    // projects its own `readable` list instead.
    const projection = entry.readable ?? entry.writable;

    const rows = await executor
      .select()
      .from(table)
      .where(gt(table.syncSeq, since))
      .orderBy(asc(table.syncSeq));

    for (const row of rows) {
      const data: Record<string, unknown> = {};
      for (const field of projection) {
        data[field] = (row as Record<string, unknown>)[field];
      }

      changes.push({
        table: name,
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        syncSeq: row.syncSeq,
        data,
      });
    }
  }

  return changes;
}
