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

export async function mutate(input: MutateInput): Promise<string> {
  const rowId = input.rowId ?? uuidv7();
  const now = new Date().toISOString();

  const mutation: OutboxEntry = {
    id: uuidv7(),
    table: input.table,
    rowId,
    op: input.op,
    payload: input.payload ?? {},
    updatedAt: now,
    createdAt: now,
    attempts: 0,
  };

  await db.transaction('rw', db.records, db.outbox, async () => {
    const existing = await db.records.get([input.table, rowId] as never);

    const next: LocalRecord = {
      table: input.table,
      id: rowId,
      updatedAt: now,
      // Soft delete only. A hard delete would resurrect the row on the next pull.
      deletedAt:
        input.op === 'delete' ? now : input.op === 'restore' ? null : (existing?.deletedAt ?? null),
      syncedAt: null,
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
 * The server holds something newer. The mutation is dead — keeping it queued would
 * retry it forever. ADR-0001: conflicts get logged, not silently discarded.
 */
export async function discardStale(ids: string[]): Promise<void> {
  await db.outbox.bulkDelete(ids);
}
