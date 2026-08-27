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
import type { Envelope } from '@/crypto/envelope';

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
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id),
    freezeDate: date('freeze_date').notNull(),
  },
  (table) => [
    index('habit_freezes_updated_at_idx').on(table.updatedAt),
    index('habit_freezes_sync_seq_idx').on(table.syncSeq),
    index('habit_freezes_habit_id_idx').on(table.habitId),
    uniqueIndex('habit_freezes_habit_id_freeze_date_idx').on(table.habitId, table.freezeDate),
  ],
);

export type HabitFreeze = typeof habitFreezes.$inferSelect;
export type NewHabitFreeze = typeof habitFreezes.$inferInsert;

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
    /**
     * Which passkey minted this session (issue #854). Nullable — sessions minted
     * before this column existed stay `null` and are simply never matched by
     * `ON DELETE CASCADE` or the "this device" comparison. Cascade lets revoking a
     * credential end that device's sessions in the same transaction.
     */
    credentialId: uuid('credential_id').references(() => credentials.id, {
      onDelete: 'cascade',
    }),
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
    recoveryCodeId: uuid('recovery_code_id').references(() => recoveryCodes.id),
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
    bucket: text('bucket').$type<'options' | 'recovery'>().notNull(),
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
    kind: text('kind').notNull(),
    sendDate: date('send_date').notNull(),
    slot: text('slot').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('reminder_sends_kind_send_date_slot_idx').on(table.kind, table.sendDate, table.slot)],
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
    index('reminder_prefs_updated_at_idx').on(table.updatedAt),
    index('reminder_prefs_sync_seq_idx').on(table.syncSeq),
    uniqueIndex('reminder_prefs_kind_idx').on(table.kind),
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
    index('category_colors_updated_at_idx').on(table.updatedAt),
    index('category_colors_sync_seq_idx').on(table.syncSeq),
    uniqueIndex('category_colors_category_idx').on(table.category),
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
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id),
    originalDate: date('original_date').notNull(),
    cancelled: boolean('cancelled').notNull().default(false),
    overrideStartsAt: timestamp('override_starts_at', { withTimezone: true }),
    overrideEndsAt: timestamp('override_ends_at', { withTimezone: true }),
    overrideStartDate: date('override_start_date'),
    overrideEndDate: date('override_end_date'),
  },
  (table) => [
    index('event_exceptions_updated_at_idx').on(table.updatedAt),
    index('event_exceptions_sync_seq_idx').on(table.syncSeq),
    index('event_exceptions_event_id_idx').on(table.eventId),
    uniqueIndex('event_exceptions_event_id_original_date_idx').on(
      table.eventId,
      table.originalDate,
    ),
  ],
);

export type EventException = typeof eventExceptions.$inferSelect;
export type NewEventException = typeof eventExceptions.$inferInsert;
