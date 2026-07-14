import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The four columns every synchronised table must carry (ARCHITECTURE.md).
 *
 * - `id`        UUIDv7, generated on the client so offline creation needs no roundtrip.
 * - `updatedAt` drives both last-write-wins and the incremental pull.
 * - `deletedAt` soft delete. A hard delete would resurrect the row on the next sync.
 * - `syncedAt`  on the client: successfully pushed. On the server: when the row last
 *               arrived through push. Kept on both sides so the shapes stay identical.
 *
 * Spread this into every feature table. Do not retype it.
 */
export const syncColumns = {
  id: uuid('id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
};

/**
 * Key/value store for sync bookkeeping (last pull timestamp and the like).
 *
 * M0 deliberately ships no feature tables — this one exists so the migration chain
 * is established and the pull endpoint has something real to read.
 */
export const syncState = pgTable(
  'sync_state',
  {
    ...syncColumns,
    key: text('key').notNull().unique(),
    value: jsonb('value').notNull(),
  },
  (table) => [index('sync_state_updated_at_idx').on(table.updatedAt)],
);

export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;
