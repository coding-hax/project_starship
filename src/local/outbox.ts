import { uuidv7 } from 'uuidv7';
import { db, type LocalRecord } from './dexie';
import { isReadOnlyTable, type Mutation, type OutboxEntry, type SyncTable } from './types';

/**
 * The mutation queue. EVERY write goes through here (CLAUDE.md rule 8) — there is no
 * second way for a change to reach the server.
 *
 * The local write and the queue entry happen in one IndexedDB transaction. If they
 * were separate, a crash in between would leave the UI showing a change that will
 * never be pushed, or push one the UI never showed.
 */

export interface MutateInput {
  table: SyncTable;
  /** Omit to create a new row — a UUIDv7 is generated locally, no server roundtrip. */
  rowId?: string;
  op: 'upsert' | 'delete' | 'restore';
  /** Only the changed fields. */
  payload?: Record<string, unknown>;
}

/**
 * A logical clock, not a display of the actual time: `Date.now()` only has
 * millisecond resolution, so two `mutate()` calls in the same tick would get an
 * identical `createdAt`. Kept strictly increasing purely so `createdAt` stays a
 * useful display timestamp and tiebreaker within one session — it is no longer the
 * ordering authority for `pending()` (that is `seq`, below, issue #1145): this
 * variable resets on every reload, which is exactly what let a clock correction
 * between two writes silently reorder them before this fix.
 */
let lastTimestamp = 0;
function nextTimestamp(): string {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return new Date(lastTimestamp).toISOString();
}

/** Next device-local order number, given the outbox's current maximum (`undefined` if empty). */
export function nextOutboxSeq(maxSeq: number | undefined): number {
  return (maxSeq ?? 0) + 1;
}

/**
 * This device's arrival order (ADR-0008), oldest first. Primarily by `seq`
 * (issue #1145) — it survives a reload, unlike the old `createdAt`-only order,
 * which a clock correction between two writes could invert. Entries without a
 * numeric `seq` (pre-migration/mixed state — after a real upgrade this never
 * happens, since the Dexie v8 backfill assigns one to every existing entry) sort
 * by `createdAt` then `id`, and ahead of every `seq`-carrying entry.
 */
export function compareOutboxOrder(a: OutboxEntry, b: OutboxEntry): number {
  const aHasSeq = typeof a.seq === 'number';
  const bHasSeq = typeof b.seq === 'number';

  if (aHasSeq && bHasSeq) return a.seq - b.seq;
  if (aHasSeq !== bHasSeq) return aHasSeq ? 1 : -1;

  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortByOrder(entries: OutboxEntry[]): OutboxEntry[] {
  return [...entries].sort(compareOutboxOrder);
}

export async function mutate(input: MutateInput): Promise<string> {
  // Server-origin data (ADR-0011) — the server would reject it anyway (push/route.ts),
  // but failing here shows the bug at build time instead of after a round-trip.
  if (isReadOnlyTable(input.table)) {
    throw new Error(`${input.table} is read-only — it cannot be mutated through the outbox.`);
  }

  const rowId = input.rowId ?? uuidv7();
  const now = nextTimestamp();

  await db.transaction('rw', db.records, db.outbox, async () => {
    const existing = await db.records.get([input.table, rowId] as never);
    // Vergeben in derselben Transaktion wie Zeile+Eintrag (AK2, issue #1145) — der
    // überlappende rw-Scope serialisiert nebenläufige `mutate()`-Aufrufe (IndexedDB-
    // Spec-Garantie), sodass keine zwei Aufrufe dieselbe `seq` bekommen.
    const maxSeq = (await db.outbox.orderBy('seq').last())?.seq;
    const seq = nextOutboxSeq(maxSeq);

    const mutation: OutboxEntry = {
      id: uuidv7(),
      table: input.table,
      rowId,
      op: input.op,
      payload: input.payload ?? {},
      updatedAt: now,
      // The row version this edit was based on — null for a new row. Lets the
      // server detect an overwrite independent of any client clock (ADR-0008).
      baseSeq: existing?.syncSeq ?? null,
      createdAt: now,
      attempts: 0,
      seq,
    };

    const next: LocalRecord = {
      table: input.table,
      id: rowId,
      updatedAt: now,
      // Soft delete only. A hard delete would resurrect the row on the next pull.
      deletedAt:
        input.op === 'delete' ? now : input.op === 'restore' ? null : (existing?.deletedAt ?? null),
      syncedAt: null,
      // Unchanged until the next pull confirms the row's new sync_seq.
      syncSeq: existing?.syncSeq ?? null,
      data: { ...(existing?.data ?? {}), ...(input.payload ?? {}) },
    };

    await db.records.put(next);
    await db.outbox.add(mutation);
  });

  return rowId;
}

/**
 * Oldest first — mutations must reach the server in the order they were made.
 * `toArray()` + an in-JS sort, not `orderBy('seq')`: the `seq` index is sparse
 * (entries from before the Dexie v8 backfill may lack it), and a blind index scan
 * would silently drop those. Negligible for a single-user outbox of at most a few
 * dozen entries.
 */
export async function pending(): Promise<OutboxEntry[]> {
  return sortByOrder(await db.outbox.toArray());
}

export async function size(): Promise<number> {
  return db.outbox.count();
}

/**
 * Applied server-side. Drop from the queue and stamp the local row as synced —
 * but only once nothing for that row is left queued. The old guard compared
 * `row.updatedAt <= m.updatedAt` (a client clock), which stamped a row as synced
 * even while a newer, still-queued edit sat behind it if that edit happened to
 * carry an earlier-looking timestamp (a backdated clock, issue #1145). Deleting
 * first and then reading the remaining queue once is uhr-independent: it looks at
 * what is *actually* still pending, not at what a clock claims came before what.
 */
export async function markApplied(mutations: Mutation[]): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction('rw', db.records, db.outbox, async () => {
    for (const m of mutations) {
      await db.outbox.delete(m.id);
    }

    const remaining = await db.outbox.toArray();
    const stillQueued = new Set(remaining.map((entry) => `${entry.table}:${entry.rowId}`));

    for (const m of mutations) {
      if (stillQueued.has(`${m.table}:${m.rowId}`)) continue;
      const row = await db.records.get([m.table, m.rowId] as never);
      if (row) {
        await db.records.put({ ...row, syncedAt: now });
      }
    }
  });
}

/**
 * The push failed. The entry stays queued and is retried on the next sync —
 * that is the whole point of the outbox surviving a reload.
 *
 * `offline` does not count towards `SYNC_ERROR_THRESHOLD` (#182) — being offline
 * says nothing about whether the mutation itself is ever going to succeed, unlike
 * a server rejecting it N times in a row.
 */
export async function markFailed(ids: string[], error: string, offline = false): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const id of ids) {
      const entry = await db.outbox.get(id);
      if (entry) {
        await db.outbox.put({
          ...entry,
          attempts: offline ? entry.attempts : entry.attempts + 1,
          lastError: error,
        });
      }
    }
  });
}

/** Above this many non-offline failures in a row, the sync error is worth surfacing. */
export const SYNC_ERROR_THRESHOLD = 5;

/** True once any queued mutation has failed at least `SYNC_ERROR_THRESHOLD` times. */
export function overSyncErrorThreshold(entries: OutboxEntry[]): boolean {
  return entries.some((entry) => entry.attempts >= SYNC_ERROR_THRESHOLD);
}

/**
 * The mutation was rejected as malformed (missing a required field). It is dead —
 * keeping it queued would retry it forever. A genuine conflict is no longer routed
 * here: arrival wins (ADR-0008), so a conflicted mutation is applied and goes
 * through `markApplied` instead.
 */
export async function discardStale(ids: string[]): Promise<void> {
  await db.outbox.bulkDelete(ids);
}
