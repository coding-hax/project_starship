import Dexie, { type EntityTable } from 'dexie';
import type { OutboxEntry, SyncTable } from './types';

/**
 * A row as it lives on the client. IndexedDB is the truth the UI reads from —
 * the API is never queried directly (CLAUDE.md rule 8).
 *
 * M0 keeps one generic store keyed by [table+id]. When the first real entity lands
 * in M1 it gets its own typed Dexie table; this store stays as the sync substrate.
 */
export interface LocalRecord {
  table: SyncTable;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set once the row has been confirmed by the server. Null while still in flight. */
  syncedAt: string | null;
  /**
   * The server's `sync_seq` for this row version (ADR-0008). Null until the first
   * pull confirms it — a row created locally and not yet pulled back has none yet.
   * Drives the pull merge (supersedes an `updatedAt` comparison) and becomes the
   * next mutation's `baseSeq`.
   */
  syncSeq: number | null;
  data: Record<string, unknown>;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

const db = new Dexie('starship') as Dexie & {
  outbox: EntityTable<OutboxEntry, 'id'>;
  records: EntityTable<LocalRecord, 'id'>;
  meta: EntityTable<MetaEntry, 'key'>;
};

db.version(1).stores({
  outbox: 'id, createdAt, table',
  records: '[table+id], table, updatedAt, syncedAt',
  meta: 'key',
});

export { db };

/**
 * The pull cursor (ADR-0008): the highest `sync_seq` seen so far. A missing value
 * starts at `0`, i.e. a one-time full pull — unremarkable, since pull is idempotent
 * and the server is the truth.
 */
export const META_LAST_PULLED_SEQ = 'lastPulledSeq';

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
