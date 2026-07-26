import { sql, type SQLWrapper } from 'drizzle-orm';

/**
 * A fixed, arbitrary key for `pg_advisory_xact_lock` — any bigint works, it only
 * has to be the same one everywhere a sync write happens. `push` (client
 * mutations) and `/api/garmin-sync` (server-origin writes, ADR-0011) both take it
 * in their write transaction, so the two can never interleave and hand out
 * `sync_seq` values out of commit order — a puller reading the sequence range in
 * between would otherwise skip a row for good (ADR-0008).
 */
export const SYNC_WRITE_LOCK_KEY = 5_326_004;

export async function acquireSyncWriteLock(tx: {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
}): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SYNC_WRITE_LOCK_KEY})`);
}
