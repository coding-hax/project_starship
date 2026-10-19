import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Envelope } from '@/crypto/envelope';

/**
 * Global, strictly increasing arrival order across every synchronised table
 * (ADR-0008). One sequence, not one per table, because the client keeps a
 * single pull cursor for all tables.
 */
export const syncSeq = pgSequence('sync_seq');

/**
 * One account. Not synchronised — an account is infrastructure like `sessions`,
 * not a row a client may push (ADR-0031), so it carries no `syncColumns` and has
 * no `SYNC_REGISTRY` entry.
 *
 * `role` is the whole authorisation model: `'admin'` additionally sees /admin.
 * No second auth stack, no permission table (ADR-0031 decision 3).
 *
 * `blockedAt` is a lock, not a delete: the rows stay, `requireUser()` answers
 * 403 instead of 401 so the client can tell "gesperrt" from "abgemeldet".
 * Deleting an account is a hard delete and takes every row with it through
 * `ON DELETE CASCADE` on `userId` below — deliberately not a tombstone, which
 * would heal itself from any device that still holds the data.
 *
 * `displayName` is a label the admin assigns to recognise the account in /admin.
 * It is never user content and never shown to anyone but an admin.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    role: text('role').$type<'admin' | 'user'>().notNull().default('user'),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [index('users_role_idx').on(table.role)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * The six columns every synchronised table must carry (ARCHITECTURE.md).
 *
 * - `userId`    the owning account (ADR-0031). Part of the primary key, see
 *               `tenantPrimaryKey` below — not just a filter column.
 * - `id`        UUIDv7, generated on the client so offline creation needs no roundtrip.
 *               Unique only *within* an account: two accounts may legitimately hold
 *               the same `id`, which is exactly what the checked-in fixed row ids
 *               (`JOURNAL_HABIT_ID`, `JOURNAL_KEYS_ROW_ID`, ADR-0016) need.
 * - `updatedAt` display/tiebreaker only — no longer the conflict authority (ADR-0008).
 * - `deletedAt` soft delete. A hard delete would resurrect the row on the next sync.
 * - `syncedAt`  on the client: successfully pushed. On the server: when the row last
 *               arrived through push. Kept on both sides so the shapes stay identical.
 * - `syncSeq`   arrival order from `sync_seq` (ADR-0008). The conflict authority:
 *               highest sequence number wins. Never set by the client — see
 *               `src/db/sync-tables.ts`. Set explicitly (`nextval`) on every write,
 *               not as a column default, because a default does not fire on UPDATE.
 *               Stays one global sequence across all accounts: the pull filters by
 *               `userId`, so an account simply sees gaps in the numbering.
 *
 * Spread this into every feature table. Do not retype it.
 */
export const syncColumns = {
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  syncSeq: bigint('sync_seq', { mode: 'number' }).notNull(),
};

/**
 * `(user_id, id)` instead of `id` alone — every synchronised table, no exception
 * (ADR-0031, enforced by `scripts/check-tenant-isolation.sh`).
 *
 * A composite key is what makes the dangerous case structural rather than
 * forbidden: a push carrying another account's `rowId` lands as *that account's
 * own* row, it can never overwrite the stranger's. With `id` alone as the key,
 * the same push would hit the existing row and only a `WHERE user_id = …` that
 * someone remembered to write would stand between the two accounts.
 */
function tenantPrimaryKey(table: { userId: AnyColumn; id: AnyColumn }) {
  return primaryKey({ columns: [table.userId, table.id] });
}

/** Drizzle's column type, narrowed to what `tenantPrimaryKey`/`tenantForeignKey` need. */
type AnyColumn = AnyPgColumn;

/**
 * A reference from one synchronised table to another, scoped to one account:
 * `(user_id, <column>) → (user_id, id)`.
 *
 * The point is not convenience — it is that a cross-tenant reference fails at
 * the database. A plain `habit_id → habits.id` would happily let an account
 * hang a log on a stranger's routine, and nothing but care in the push handler
 * would notice.
 *
 * No `onDelete` action anywhere: deleting a row is always a tombstone
 * (ARCHITECTURE.md), never a `DELETE`, so the action would never fire. The one
 * real delete — dropping an account — cascades from `users` instead.
 */
function tenantForeignKey(
  columns: [AnyColumn, AnyColumn],
  foreignColumns: [AnyColumn, AnyColumn],
  name: string,
) {
  return foreignKey({ columns, foreignColumns, name });
}

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
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('sync_state_updated_at_idx').on(table.updatedAt),
    index('sync_state_sync_seq_idx').on(table.syncSeq),
    // Per account, not globally — two accounts each keep their own cursor under
    // the same key (ADR-0031).
    uniqueIndex('sync_state_user_id_key_idx').on(table.userId, table.key),
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
     * Self-referencing, nullable — one level of subtasks (issue #89). The reference
     * is composite (`tenantForeignKey` below), so a subtask can never point at a
     * parent in another account. Cascading to children stays app logic.
     */
    parentId: uuid('parent_id'),
  },
  (table) => [
    tenantPrimaryKey(table),
    tenantForeignKey([table.userId, table.parentId], [table.userId, table.id], 'tasks_parent_fk'),
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
 * `target` is "how often per period", only > 1 for `weekly` (issue #509).
 */
export const habits = pgTable(
  'habits',
  {
    ...syncColumns,
    name: text('name').notNull(),
    schedule: text('schedule').$type<
      'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom'
    >().notNull(),
    target: integer('target').notNull().default(1),
    color: text('color'),
    emoji: text('emoji'),
    /** Archiving, not deleting — the streak history stays intact. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantPrimaryKey(table),
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
    habitId: uuid('habit_id').notNull(),
    logDate: date('log_date').notNull(),
    done: boolean('done').notNull().default(true),
  },
  (table) => [
    tenantPrimaryKey(table),
    tenantForeignKey([table.userId, table.habitId], [habits.userId, habits.id], 'habit_logs_habit_fk'),
    index('habit_logs_updated_at_idx').on(table.updatedAt),
    index('habit_logs_sync_seq_idx').on(table.syncSeq),
    index('habit_logs_habit_id_idx').on(table.habitId),
    uniqueIndex('habit_logs_user_id_habit_id_log_date_idx').on(
      table.userId,
      table.habitId,
      table.logDate,
    ),
  ],
);

export type HabitLog = typeof habitLogs.$inferSelect;
export type NewHabitLog = typeof habitLogs.$inferInsert;

/**
 * A streak "joker": manually spent to bridge one missed due day instead of
 * breaking the streak (issue #433, M-3 of #416). Dormant since issue #796 —
 * the feature (quota math, eligibility, UI) was removed, but this table and
 * its rows stay untouched (no migration, no data loss) in case it returns.
 * `freezeDate` is a calendar day (`date`, not `timestamp`) like `logDate`,
 * same day-boundary reasoning. No `onDelete` cascade on `habitId`: tombstone
 * convention like `habitLogs`.
 */
export const habitFreezes = pgTable(
  'habit_freezes',
  {
    ...syncColumns,
    habitId: uuid('habit_id').notNull(),
    freezeDate: date('freeze_date').notNull(),
  },
  (table) => [
    tenantPrimaryKey(table),
    tenantForeignKey(
      [table.userId, table.habitId],
      [habits.userId, habits.id],
      'habit_freezes_habit_fk',
    ),
    index('habit_freezes_updated_at_idx').on(table.updatedAt),
    index('habit_freezes_sync_seq_idx').on(table.syncSeq),
    index('habit_freezes_habit_id_idx').on(table.habitId),
    uniqueIndex('habit_freezes_user_id_habit_id_freeze_date_idx').on(
      table.userId,
      table.habitId,
      table.freezeDate,
    ),
  ],
);

export type HabitFreeze = typeof habitFreezes.$inferSelect;
export type NewHabitFreeze = typeof habitFreezes.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Auth. None of this is ever synchronised, so none of it carries syncColumns. */
/* -------------------------------------------------------------------------- */

/**
 * Registered passkeys — a phone and a laptop are two credentials of the same
 * account.
 *
 * `credentialId` stays **globally** unique, unlike the synchronised tables
 * above: it is what the login ceremony presents, and resolving it to an account
 * is the whole point (ADR-0031). A per-account uniqueness would mean two
 * accounts could register the same authenticator and login could no longer tell
 * whose session to mint.
 */
export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
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
    /**
     * Whose session this is (ADR-0031). This column *is* the authorisation:
     * `requireUser()` reads it here instead of deriving a single owner id from
     * the environment, which is what made the pre-#1200 owner check
     * tautological.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Which passkey minted this session (issue #854). Nullable — sessions minted
     * before this column existed stay `null` and are simply never matched by
     * `ON DELETE CASCADE` or the "this device" comparison. Cascade lets revoking a
     * credential end that device's sessions in the same transaction.
     */
    credentialId: uuid('credential_id').references(() => credentials.id, {
      onDelete: 'cascade',
    }),
    /**
     * Which browser profile this session was opened from (issue #1102). A synced
     * passkey is the *same* credential on every Apple device at one keychain, so
     * `credential_id` alone cannot tell an iPhone from a Mac — this can.
     *
     * A label, never a key: nothing in the authorisation path reads it. Nullable
     * like `credential_id` above, for the same reason — sessions minted before
     * this column existed stay `null`, and the login sweep treats them as
     * residue of the device that is logging in.
     */
    deviceId: text('device_id'),
    /**
     * Last authenticated request through this session (issue #1103). Dropped in
     * #857 for being a dead column — the auth middleware only checked cookie
     * presence, no DB access (#599). Comes back *alive* this time: `requireUser()`
     * writes it through a throttled, guarded `UPDATE` (at most once per hour per
     * session), never once per request, so the cheap-write-path concern from #857
     * still holds. Nullable, no default — a session minted before this column
     * existed, or never re-authenticated since, stays `null` ("noch nie").
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_expires_at_idx').on(table.expiresAt),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

/**
 * An admin-issued invitation link — the only door into the installation since
 * S3 (#1202, ADR-0031): there is no open registration form any more.
 *
 * Server infrastructure like `sessions`/`recoveryCodes` — no `syncColumns`, no
 * `SYNC_REGISTRY` entry, no Dexie counterpart; `check-tenant-isolation.sh`
 * only scans tables that spread `syncColumns`, so this one is structurally
 * outside its reach.
 *
 * `tokenHash` stays globally unique for the same reason `credentials.credentialId`
 * does: the plaintext token is presented without an account and has to resolve to
 * one. The plaintext itself is returned exactly once, by `createInvite` — never
 * stored, never logged.
 *
 * `userId` is nullable for two different reasons depending on which side set it:
 * - at creation, null means "a fresh account will be minted when someone redeems
 *   this" (the ordinary user invite);
 * - `scripts/bootstrap-admin.ts` instead pre-binds it to the admin account it just
 *   created, so redeeming that invite attaches a passkey to an *existing* account
 *   instead of minting a second one.
 * Either way, after redemption it names the account the invite produced or joined
 * (AK1) — `burnInvite` is what fills it in the first case.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invites_expires_at_idx').on(table.expiresAt)],
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

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
    recoveryCodeId: uuid('recovery_code_id').references(() => recoveryCodes.id),
    /**
     * Which invite is redeeming through this challenge (#1202, S3), mirroring
     * `recoveryCodeId` below — server-side for the same reason: a client that
     * could name the invite in the request body could redeem someone else's.
     * Null for every ceremony that isn't invite-backed (session/recovery).
     */
    inviteId: uuid('invite_id').references(() => invites.id),
    /**
     * Which account the registration about to happen belongs to (ADR-0031).
     * Server-side for the same reason the challenge itself is: a client that
     * could name the account would be a client that could enrol a passkey into
     * a stranger's.
     *
     * Null means "no account yet" — either a pending user-invite redemption (the
     * account is minted inside `verify`'s transaction) or, before #1202, first
     * setup. An abandoned ceremony therefore leaves no empty account behind.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('auth_challenges_expires_at_idx').on(table.expiresAt)],
);

/**
 * The recovery code, hashed. Shown exactly once, at first setup.
 *
 * `codeHash` stays globally unique for the same reason as
 * `credentials.credentialId`: the code is presented without an account and has
 * to resolve to one.
 */
export const recoveryCodes = pgTable('recovery_codes', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
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
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    // Per account, not globally: a push endpoint belongs to a *browser*, and two
    // people using the same browser would otherwise fight over one row. Which of
    // them actually receives a notification is a separate problem — logging out
    // has to drop the subscription (#1205, S6).
    uniqueIndex('push_subscriptions_user_id_endpoint_idx').on(table.userId, table.endpoint),
    index('push_subscriptions_user_id_idx').on(table.userId),
  ],
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;

/**
 * Fixed-window request counter for the unauthenticated auth endpoints (issue #755).
 * Server-/infra-only like `sessions`/`auth_challenges` above — no `syncColumns`, never
 * in `SYNC_TABLES`, no Dexie counterpart.
 *
 * One row per `(bucket, key, window_start)`, `count` incremented atomically
 * (`onConflictDoUpdate`, see `src/auth/rate-limit.ts`) rather than one row per hit —
 * row count stays O(keys × windows), not O(attack requests). `bucket` separates the
 * generous `options` budget from the stricter `recovery` budget (AC3); `key` is the
 * caller's IP (`src/auth/rate-limit.ts` `clientKey`). Pruned on every write, same
 * pattern as `storeChallenge` for `auth_challenges`.
 */
export const authRateLimits = pgTable(
  'auth_rate_limits',
  {
    id: uuid('id').primaryKey(),
    bucket: text('bucket').$type<'options' | 'recovery' | 'invite'>().notNull(),
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [
    uniqueIndex('auth_rate_limits_bucket_key_window_idx').on(
      table.bucket,
      table.key,
      table.windowStart,
    ),
    index('auth_rate_limits_window_start_idx').on(table.windowStart),
  ],
);

export type AuthRateLimit = typeof authRateLimits.$inferSelect;
export type NewAuthRateLimit = typeof authRateLimits.$inferInsert;

/**
 * Double-send lock for the reminder cron (issue #239). Server-/cron-infrastructure
 * like `pushSubscriptions` — no `syncColumns`, no Dexie counterpart, the client never
 * reads this table.
 *
 * `slot` is `'HH:MM'`, not just the reminder kind, because a kind can have more than
 * one time of day (T5): the unique index on `(kind, send_date, slot)` must let a
 * 07:00 and a 20:00 reminder of the same kind each claim their own row on the same
 * day, instead of the second one finding the first's row and silently skipping.
 */
export const reminderSends = pgTable(
  'reminder_sends',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sendDate: date('send_date').notNull(),
    slot: text('slot').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Per account (ADR-0031): two accounts must both be able to claim the same
  // slot on the same day, one account never twice.
  (table) => [
    uniqueIndex('reminder_sends_user_id_kind_send_date_slot_idx').on(
      table.userId,
      table.kind,
      table.sendDate,
      table.slot,
    ),
  ],
);

export type ReminderSend = typeof reminderSends.$inferSelect;
export type NewReminderSend = typeof reminderSends.$inferInsert;

/**
 * Per-kind reminder preferences (issue #244, "M3-T5"). Synchronised like any domain
 * table (`syncColumns`) — Regel 8 forbids the UI writing straight to the cron's
 * read path, so a preference has to travel through the same outbox/push/pull
 * plumbing as tasks/habits and land in Postgres for `sendDueReminders()` to read.
 *
 * One row per `kind` (`uniqueIndex`), not one row per time: an empty `times` array
 * means "deliberately no time" and must not fall back to the registry defaults —
 * a row-per-time design would lose that distinction the moment the last time is
 * removed. No row at all means "never configured" and does fall back to the
 * registry defaults (src/push/reminders/reminder-kinds.ts).
 *
 * Never tombstoned — a row always names one of the fixed kinds, so there is
 * nothing to delete, only to change.
 */
export const reminderPrefs = pgTable(
  'reminder_prefs',
  {
    ...syncColumns,
    kind: text('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    times: jsonb('times').$type<string[]>().notNull().default([]),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('reminder_prefs_updated_at_idx').on(table.updatedAt),
    index('reminder_prefs_sync_seq_idx').on(table.syncSeq),
    uniqueIndex('reminder_prefs_user_id_kind_idx').on(table.userId, table.kind),
  ],
);

export type ReminderPref = typeof reminderPrefs.$inferSelect;
export type NewReminderPref = typeof reminderPrefs.$inferInsert;

/**
 * User-chosen override for a calendar category's accent color (issue #660).
 * Synchronised like `reminderPrefs` above — a category color is a domain
 * assignment ("Arbeit ist blau"), not a device setting, so it must not differ
 * between phone and laptop. One row per `category` (`uniqueIndex`); no row means
 * "use the `--cat-<category>` default from tokens.css" (AC5), so this table is
 * additive-only and never carries a default color of its own.
 *
 * `color` holds a `--swatch-*` token name (src/ui/swatch-palette.ts), not a
 * resolved value — CategoryColorsBoot writes it into an inline `var()` reference
 * on `<html>`, never a computed color, so it keeps resolving correctly per theme
 * (AC7).
 */
export const categoryColors = pgTable(
  'category_colors',
  {
    ...syncColumns,
    category: text('category').notNull(),
    color: text('color').notNull(),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('category_colors_updated_at_idx').on(table.updatedAt),
    index('category_colors_sync_seq_idx').on(table.syncSeq),
    uniqueIndex('category_colors_user_id_category_idx').on(table.userId, table.category),
  ],
);

export type CategoryColor = typeof categoryColors.$inferSelect;
export type NewCategoryColor = typeof categoryColors.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Journal (M4, ADR-0004/-0015/-0017). Ciphertext-only — only `entryDate`     */
/* stays plaintext (CLAUDE.md Regel 9).                                       */
/* -------------------------------------------------------------------------- */

/**
 * Text, Stimmung und Tags reisen zusammen in einem AES-GCM-Chiffrat (ADR-0004) —
 * kein feldweiser Merge, eine upsert-Mutation ersetzt `ciphertext`/`nonce` gemeinsam.
 * `ciphertext`/`nonce` sind `text` (Base64), nicht `bytea` — das Wire-Format ist
 * JSON, und src/crypto/base64.ts liefert ohnehin Base64-Strings.
 *
 * Ein Tag kann mehrere Einträge tragen (issue #376, ADR-0018) — `entry_date` ist
 * deshalb nicht mehr eindeutig, und `id` ist client-zufällig (UUIDv7) statt
 * deterministisch aus `entry_date` (ADR-0017 Punkt 1, abgelöst). `created_at` ist
 * die Sortier-/Anzeigeanker, wie bei `tasks`/`habits` oben — `syncSeq` ändert sich
 * bei jedem Update und taugt nicht als Erstellzeit.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    ...syncColumns,
    entryDate: date('entry_date').notNull(),
    ciphertext: text('ciphertext').notNull(),
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('journal_entries_updated_at_idx').on(table.updatedAt),
    index('journal_entries_sync_seq_idx').on(table.syncSeq),
    index('journal_entries_entry_date_idx').on(table.entryDate),
    index('journal_entries_created_at_idx').on(table.createdAt),
  ],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

/**
 * Die gewickelte DEK-Hülle (ADR-0015) — reines Chiffrat (kdfParams/wrappedDek/nonce),
 * darf synchronisiert werden: ohne Passphrase ist sie wertlos. `envelope` trägt den
 * `Envelope`-Typ aus src/crypto/envelope.ts nur als **Typ** — DB-Code importiert nie
 * Krypto-Laufzeitcode (CLAUDE.md Regel 9).
 */
export const journalKeys = pgTable(
  'journal_keys',
  {
    ...syncColumns,
    envelope: jsonb('envelope').$type<Envelope>().notNull(),
    recoveryEnvelope: jsonb('recovery_envelope').$type<Envelope>(),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('journal_keys_updated_at_idx').on(table.updatedAt),
    index('journal_keys_sync_seq_idx').on(table.syncSeq),
  ],
);

export type JournalKeys = typeof journalKeys.$inferSelect;
export type NewJournalKeys = typeof journalKeys.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Termine (M5, issue #552, S1 of #473). Foundation only — no route/UI yet.   */
/* -------------------------------------------------------------------------- */

/**
 * Two time models share this table, never the same row: a scheduled event carries
 * a UTC instant (`startsAt`/`endsAt`), an all-day/multi-day event carries a
 * calendar-day key with no time (`startDate`/`endDate`) — a naive local datetime is
 * ambiguous across the autumn DST fold, an instant is not. `allDay` is the
 * discriminator; a query must branch on it rather than guess from which columns are
 * set. `endDate: null` means a one-day all-day event. No timezone conversion lives
 * here (`src/push/schedule.ts` `berlinNow` stays the only DST-aware reference) —
 * S1 only shapes the columns so the two models can never collide (issue #552 AC5).
 *
 * `recurrence`/`reminderMinutes` are reserved for S6/S7, same pattern as
 * `tasks.recurrenceRule` — carried now so those stages need no second migration.
 * `recurrence` is deliberately a narrow JSON shape (freq/interval/byWeekday?/
 * until?/count?), not an `rrule` string — no new dependency without an ADR (Regel
 * 3). `reminderMinutes` is a single integer ("15 Minuten vorher" per S7), not an
 * array — multiple reminders per event is additive if ever needed.
 */
export const events = pgTable(
  'events',
  {
    ...syncColumns,
    title: text('title').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    startDate: date('start_date'),
    endDate: date('end_date'),
    category: text('category').$type<
      'privat' | 'arbeit' | 'gesundheit' | 'sport' | 'familie'
    >(),
    recurrence: jsonb('recurrence').$type<{
      freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
      interval: number;
      byWeekday?: number[];
      until?: string;
      count?: number;
    }>(),
    reminderMinutes: integer('reminder_minutes'),
  },
  (table) => [
    tenantPrimaryKey(table),
    index('events_updated_at_idx').on(table.updatedAt),
    index('events_sync_seq_idx').on(table.syncSeq),
    index('events_starts_at_idx').on(table.startsAt),
    index('events_start_date_idx').on(table.startDate),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/**
 * One exception to a recurring `events` row — moved to a different time/date, or
 * cancelled outright — never a list column on `events` itself (issue #552 AC6): a
 * list would collide the moment two devices move different instances of the same
 * series offline, each overwriting the other's edit on next sync. A dedicated
 * table upserts on the natural key `(eventId, originalDate)` instead, same
 * pattern as `habitLogs`/`habitFreezes` (issue #475) — two devices moving the same
 * instance each mint their own row id, but the natural key + delete-wins conflict
 * rule (ADR-0008) collapse them to one. No `onDelete` cascade on `eventId`:
 * deleting is always a tombstone (see ARCHITECTURE.md), never a hard `DELETE`, so
 * the FK action never fires. `overrideStartsAt`/`overrideEndsAt` and
 * `overrideStartDate`/`overrideEndDate` mirror the same instant-vs-calendar-day
 * split as `events` — an exception can move a timed event to another instant, or
 * an all-day event to another day, never mixing the two models.
 */
export const eventExceptions = pgTable(
  'event_exceptions',
  {
    ...syncColumns,
    eventId: uuid('event_id').notNull(),
    originalDate: date('original_date').notNull(),
    cancelled: boolean('cancelled').notNull().default(false),
    overrideStartsAt: timestamp('override_starts_at', { withTimezone: true }),
    overrideEndsAt: timestamp('override_ends_at', { withTimezone: true }),
    overrideStartDate: date('override_start_date'),
    overrideEndDate: date('override_end_date'),
  },
  (table) => [
    tenantPrimaryKey(table),
    tenantForeignKey(
      [table.userId, table.eventId],
      [events.userId, events.id],
      'event_exceptions_event_fk',
    ),
    index('event_exceptions_updated_at_idx').on(table.updatedAt),
    index('event_exceptions_sync_seq_idx').on(table.syncSeq),
    index('event_exceptions_event_id_idx').on(table.eventId),
    uniqueIndex('event_exceptions_user_id_event_id_original_date_idx').on(
      table.userId,
      table.eventId,
      table.originalDate,
    ),
  ],
);

export type EventException = typeof eventExceptions.$inferSelect;
export type NewEventException = typeof eventExceptions.$inferInsert;
