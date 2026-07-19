import {
  bigint,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Global, strictly increasing arrival order across every synchronised table
 * (ADR-0008). One sequence, not one per table, because the client keeps a
 * single pull cursor for all tables.
 */
export const syncSeq = pgSequence('sync_seq');

/**
 * The five columns every synchronised table must carry (ARCHITECTURE.md).
 *
 * - `id`        UUIDv7, generated on the client so offline creation needs no roundtrip.
 * - `updatedAt` display/tiebreaker only — no longer the conflict authority (ADR-0008).
 * - `deletedAt` soft delete. A hard delete would resurrect the row on the next sync.
 * - `syncedAt`  on the client: successfully pushed. On the server: when the row last
 *               arrived through push. Kept on both sides so the shapes stay identical.
 * - `syncSeq`   arrival order from `sync_seq` (ADR-0008). The conflict authority:
 *               highest sequence number wins. Never set by the client — see
 *               `src/db/sync-tables.ts`. Set explicitly (`nextval`) on every write,
 *               not as a column default, because a default does not fire on UPDATE.
 *
 * Spread this into every feature table. Do not retype it.
 */
export const syncColumns = {
  id: uuid('id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
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
  (table) => [
    index('sync_state_updated_at_idx').on(table.updatedAt),
    index('sync_state_sync_seq_idx').on(table.syncSeq),
  ],
);

export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;

/**
 * `recurrenceRule` is reserved for a later milestone (see VISION.md) — carried in
 * the schema now so M1 does not need another migration to add it, but nothing
 * writes to it yet.
 */
export const tasks = pgTable(
  'tasks',
  {
    ...syncColumns,
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    priority: integer('priority').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recurrenceRule: text('recurrence_rule'),
    /**
     * Stable creation timestamp — `syncSeq` changes on every update, so it cannot
     * anchor the chronological running list (issue #88). `defaultNow()` backfills
     * existing rows and covers old clients that push a create without it.
     */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_updated_at_idx').on(table.updatedAt),
    index('tasks_due_at_idx').on(table.dueAt),
    index('tasks_sync_seq_idx').on(table.syncSeq),
    index('tasks_created_at_idx').on(table.createdAt),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Auth. None of this is ever synchronised, so none of it carries syncColumns. */
/* -------------------------------------------------------------------------- */

/** Registered passkeys. Single user, but a phone and a laptop are two credentials. */
export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').$type<string[]>().notNull().default([]),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/**
 * Sessions are opaque random tokens, stored only as a SHA-256 hash (ADR-0003).
 * Opaque means revocable — a JWT would not be.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
);

/**
 * WebAuthn challenges. Kept server-side rather than in a cookie so a replay cannot
 * be mounted by handing the client its own challenge back.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey(),
    challenge: text('challenge').notNull(),
    kind: text('kind').$type<'registration' | 'authentication'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_challenges_expires_at_idx').on(table.expiresAt)],
);

/** The recovery code, hashed. Shown exactly once, at first setup. */
export const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export type Credential = typeof credentials.$inferSelect;
export type Session = typeof sessions.$inferSelect;
