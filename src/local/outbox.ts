import { uuidv7 } from 'uuidv7';
import { db, type LocalRecord } from './dexie';
import type { Mutation, OutboxEntry, SyncTable } from './types';

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
 * identical `createdAt` — and `pending()`'s ordering (this device's arrival order,
 * ADR-0008) would then depend on IndexedDB's tie-break by primary key (the
 * mutation's random UUIDv7), not on call order. Nudging forward by at least 1ms
 * per call keeps `createdAt` strictly increasing, so it stays a valid stand-in for
 * "the order this device made these mutations in".
 */
let lastTimestamp = 0;
function nextTimestamp(): string {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return new Date(lastTimestamp).toISOString();
}

export async function mutate(input: MutateInput): Promise<string> {
  const rowId = input.rowId ?? uuidv7();
  const now = nextTimestamp();

  await db.transaction('rw', db.records, db.outbox, async () => {
    const existing = await db.records.get([input.table, rowId] as never);

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

/** Oldest first — mutations must reach the server in the order they were made. */
export async function pending(): Promise<OutboxEntry[]> {
  return db.outbox.orderBy('createdAt').toArray();
}

export async function size(): Promise<number> {
  return db.outbox.count();
}

/** Applied server-side. Drop from the queue and stamp the local row as synced. */
export async function markApplied(mutations: Mutation[]): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction('rw', db.records, db.outbox, async () => {
    for (const m of mutations) {
      await db.outbox.delete(m.id);

      const row = await db.records.get([m.table, m.rowId] as never);
      // Only stamp if nothing newer happened locally in the meantime.
      if (row && row.updatedAt <= m.updatedAt) {
        await db.records.put({ ...row, syncedAt: now });
      }
    }
  });
}

/**
 * The push failed. The entry stays queued and is retried on the next sync —
 * that is the whole point of the outbox surviving a reload.
 */
export async function markFailed(ids: string[], error: string): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const id of ids) {
      const entry = await db.outbox.get(id);
      if (entry) {
        await db.outbox.put({ ...entry, attempts: entry.attempts + 1, lastError: error });
      }
    }
  });
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
