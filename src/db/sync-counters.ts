import { lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accountSyncCounters } from '@/db/schema';

/** The eight plain counts a day's row carries (#1235) — never a mutation id,
 * table name, endpoint, or error text (AK8). */
export type SyncCounterColumn =
  | 'rejectedMalformed'
  | 'rejectedMissingRequired'
  | 'rejectedConstraint'
  | 'rejectedQuota'
  | 'conflicts'
  | 'fullPulls'
  | 'pushSubscriptionsDropped'
  | 'pushDeliveryFailures';

export type SyncCounterDelta = Partial<Record<SyncCounterColumn, number>>;

/** Same retention as `user_activity_windows` (#1233 AK8) — no cron needed, this
 * rides along with every write (AK9). */
async function pruneOldCounters(): Promise<void> {
  await db
    .delete(accountSyncCounters)
    .where(lt(accountSyncCounters.day, sql`current_date - 31`));
}

/**
 * Bumps today's row for `userId` by `delta`, creating it on first write (AK1-3).
 * Only ever called when an event actually occurred (AK5 "kein Schreib-Hotspot"):
 * a delta with nothing positive in it is a no-op with no query at all, and the
 * one row that does get written is a single upsert — no prior `SELECT`.
 *
 * Never throws (AK6, same fail-open stance as `recordActivityWindow`): a broken
 * counter must not break the push/pull it rides along with.
 */
export async function recordSyncCounters(userId: string, delta: SyncCounterDelta): Promise<void> {
  const entries = Object.entries(delta).filter(
    (entry): entry is [SyncCounterColumn, number] => (entry[1] ?? 0) > 0,
  );
  if (entries.length === 0) return;

  try {
    const values: Record<string, unknown> = { userId, day: sql`current_date` };
    const set: Record<string, unknown> = {};
    for (const [column, amount] of entries) {
      values[column] = amount;
      set[column] = sql`${accountSyncCounters[column]} + ${amount}`;
    }

    await db
      .insert(accountSyncCounters)
      .values(values as typeof accountSyncCounters.$inferInsert)
      .onConflictDoUpdate({
        target: [accountSyncCounters.userId, accountSyncCounters.day],
        set,
      });

    await pruneOldCounters();
  } catch (error) {
    console.warn('[sync-counters] recordSyncCounters failed', error);
  }
}
