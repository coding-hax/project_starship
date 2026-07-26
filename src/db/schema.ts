import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
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
    /**
     * Self-referencing, nullable — one level of subtasks (issue #89). No `onDelete`
     * cascade: deleting is always a tombstone (see ARCHITECTURE.md), never a hard
     * `DELETE`, so the FK action never fires. Cascading to children is app logic.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => tasks.id),
  },
  (table) => [
    index('tasks_updated_at_idx').on(table.updatedAt),
    index('tasks_due_at_idx').on(table.dueAt),
    index('tasks_sync_seq_idx').on(table.syncSeq),
    index('tasks_created_at_idx').on(table.createdAt),
    index('tasks_parent_id_idx').on(table.parentId),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

/**
 * `schedule: 'custom'` is reserved for a later milestone (no UI yet), analogous to
 * `recurrenceRule` on `tasks` — carried now so M2 does not need a second migration.
 */
export const habits = pgTable(
  'habits',
  {
    ...syncColumns,
    name: text('name').notNull(),
    schedule: text('schedule').$type<'daily' | 'weekly' | 'custom'>().notNull(),
    color: text('color'),
    /** Archiving, not deleting — the streak history stays intact. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('habits_updated_at_idx').on(table.updatedAt),
    index('habits_sync_seq_idx').on(table.syncSeq),
    index('habits_created_at_idx').on(table.createdAt),
  ],
);

export type Habit = typeof habits.$inferSelect;
export type NewHabit = typeof habits.$inferInsert;

/**
 * `logDate` is a calendar day (`date`, not `timestamp`) — a streak is decided by
 * day boundaries, not by the moment the log was written. No `onDelete` cascade on
 * `habitId`: deleting is always a tombstone (see ARCHITECTURE.md), never a hard
 * `DELETE`, so the FK action never fires.
 */
export const habitLogs = pgTable(
  'habit_logs',
  {
    ...syncColumns,
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id),
    logDate: date('log_date').notNull(),
    done: boolean('done').notNull().default(true),
  },
  (table) => [
    index('habit_logs_updated_at_idx').on(table.updatedAt),
    index('habit_logs_sync_seq_idx').on(table.syncSeq),
    index('habit_logs_habit_id_idx').on(table.habitId),
    uniqueIndex('habit_logs_habit_id_log_date_idx').on(table.habitId, table.logDate),
  ],
);

export type HabitLog = typeof habitLogs.$inferSelect;
export type NewHabitLog = typeof habitLogs.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Garmin (ADR-0011). Server-origin data: read-only in the sync engine.       */
/* -------------------------------------------------------------------------- */

/**
 * OAuth1/OAuth2 token pair for `connectapi.garmin.com`. Never synchronised — like
 * the auth tables below, it carries no `syncColumns` and never appears in
 * `SYNC_TABLES` (src/local/types.ts). `token` is opaque and is never logged, not
 * even truncated.
 */
export const garminTokens = pgTable('garmin_tokens', {
  id: uuid('id').primaryKey(),
  kind: text('kind').$type<'oauth1' | 'oauth2'>().notNull().unique(),
  token: jsonb('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GarminToken = typeof garminTokens.$inferSelect;
export type NewGarminToken = typeof garminTokens.$inferInsert;

/**
 * Read-only in the sync engine (src/db/sync-tables.ts: `readOnly: true`) — written
 * only by `/api/garmin-sync`, never by a client push.
 *
 * `garminActivityId` is Garmin's own id, the natural key for the upsert; `id` stays
 * a server-generated UUIDv7 like every other synced row. `elapsedSeconds -
 * durationSeconds` is the pause length — computed in the UI, not stored.
 *
 * `track` is the downsampled time series stored column-wise
 * (`{ n, distance, lat, lon, hr, speed, elevation }`, each an array of length `n`)
 * instead of as a list of point objects — at 500 points this roughly halves the
 * JSON size, since the keys are not repeated 500 times. Nullable: filled in by a
 * later sync run if the details fetch failed the first time.
 */
export const garminActivities = pgTable(
  'garmin_activities',
  {
    ...syncColumns,
    garminActivityId: bigint('garmin_activity_id', { mode: 'number' }).notNull().unique(),
    activityType: text('activity_type').notNull(),
    name: text('name'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    distanceMeters: integer('distance_meters'),
    durationSeconds: integer('duration_seconds'),
    elapsedSeconds: integer('elapsed_seconds'),
    elevationGain: integer('elevation_gain'),
    elevationLoss: integer('elevation_loss'),
    averageHr: integer('average_hr'),
    maxHr: integer('max_hr'),
    averageSpeed: real('average_speed'),
    calories: integer('calories'),
    track: jsonb('track'),
    /** Static map image as a data URL, fetched once (src/features/garmin/static-map.ts). */
    mapImage: text('map_image'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('garmin_activities_updated_at_idx').on(table.updatedAt),
    index('garmin_activities_sync_seq_idx').on(table.syncSeq),
    index('garmin_activities_started_at_idx').on(table.startedAt),
    uniqueIndex('garmin_activities_garmin_activity_id_idx').on(table.garminActivityId),
  ],
);

export type GarminActivity = typeof garminActivities.$inferSelect;
export type NewGarminActivity = typeof garminActivities.$inferInsert;

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

/**
 * Push-Abo je Gerät (issue #122). Server-/Geräte-Infrastruktur wie `sessions` —
 * kein `syncColumns`, keine Sync-Registrierung, kein Dexie-Gegenstück: das Abo
 * gehört zum Browser-Endpunkt, nicht zu synchronisierten Nutzerdaten.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
