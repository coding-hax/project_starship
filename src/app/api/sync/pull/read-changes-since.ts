import { asc, gt } from 'drizzle-orm';
import { db } from '@/db';
import { SYNC_REGISTRY } from '@/db/sync-tables';
import { PULL_PAGE_LIMIT } from '@/local/conflict';
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
 *
 * Each per-table query is capped at `PULL_PAGE_LIMIT` (fund F5, #478) — an
 * unbounded read of an entire table's history is exactly the recovery-sync
 * timeout/OOM the fund describes. `truncated` reports whether any table hit that
 * cap, i.e. may hold rows this call never even fetched — `route.ts` folds that
 * into the response's `hasMore` alongside `pageChanges`' own overflow check, since
 * a table capped at the limit can still merge into fewer than `PULL_PAGE_LIMIT`
 * combined rows if every other table came back empty.
 */
export async function readChangesSince(
  executor: Pick<typeof db, 'select'>,
  since: number,
): Promise<{ changes: ChangeRow[]; truncated: boolean }> {
  const changes: ChangeRow[] = [];
  let truncated = false;

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
      .orderBy(asc(table.syncSeq))
      .limit(PULL_PAGE_LIMIT);

    if (rows.length === PULL_PAGE_LIMIT) truncated = true;

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

  return { changes, truncated };
}
