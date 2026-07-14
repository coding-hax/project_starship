import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
