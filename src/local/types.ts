/**
 * The wire contract between the client outbox and /api/sync.
 * Shared by both sides so the shapes cannot drift apart.
 */

/** Tables the sync engine is allowed to touch. */
export const SYNC_TABLES = [
  'sync_state',
  'tasks',
  'habits',
  'habit_logs',
  'garmin_activities',
  'reminder_prefs',
  'journal_entries',
  'journal_keys',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export function isSyncTable(value: unknown): value is SyncTable {
  return typeof value === 'string' && (SYNC_TABLES as readonly string[]).includes(value);
}

/**
 * Tables the sync engine reads but never writes: server-origin data (ADR-0011).
 * Both `push` (server) and `outbox.mutate()` (client) import from here, so the two
 * sides of the wire contract cannot drift apart on which tables are writable.
 */
export const READ_ONLY_TABLES: readonly SyncTable[] = ['garmin_activities'];

export function isReadOnlyTable(table: SyncTable): boolean {
  return (READ_ONLY_TABLES as readonly string[]).includes(table);
}

/**
 * Which fields a mutation is missing or has the wrong type for — empty means
 * well-formed. A poison mutation (one client bug away from wedging the whole
 * outbox forever, see push() in src/local/sync.ts) must be rejected on its own
 * server-side, never fail the batch it happened to travel with.
 */
export function malformedFields(m: Mutation): string[] {
  const fields: string[] = [];
  if (!isSyncTable(m?.table)) fields.push('table');
  if (typeof m?.rowId !== 'string') fields.push('rowId');
  if (typeof m?.updatedAt !== 'string') fields.push('updatedAt');
  if (typeof m?.baseSeq !== 'number' && m?.baseSeq !== null) fields.push('baseSeq');
  return fields;
}

/**
 * The client-side view of a `habits` row's `data` field (`LocalRecord.data` /
 * `Mutation.payload`, see below) — the wire shape, not the Drizzle-inferred server
 * type (`Habit` in `src/db/schema.ts`), so timestamps are ISO strings here.
 */
export interface HabitData {
  name: string;
  schedule: 'daily' | 'weekly' | 'custom';
  color: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** Same as `HabitData`, for `habit_logs`. `logDate` is `YYYY-MM-DD`, not a timestamp. */
export interface HabitLogData {
  habitId: string;
  logDate: string;
  done: boolean;
}

/**
 * Same as `HabitData`, for `reminder_prefs` (issue #244). One row per reminder
 * `kind` — see the doc comment on `reminderPrefs` in src/db/schema.ts for why an
 * empty `times` array must not be conflated with "no row at all".
 */
export interface ReminderPrefData {
  kind: string;
  enabled: boolean;
  times: string[];
}

/**
 * Same as `HabitData`, for `journal_entries` (issue #338). `ciphertext`/`nonce` are
 * Base64 (src/crypto/base64.ts) — the wire format is JSON, this is opaque text to
 * the sync engine either way. `entryDate` is `YYYY-MM-DD`, like `HabitLogData.logDate`.
 * `entryDate` is no longer unique per row (issue #376) — a day can carry several
 * entries, ordered by `createdAt`.
 */
export interface JournalEntryData {
  entryDate: string;
  ciphertext: string;
  nonce: string;
  createdAt: string;
}

/**
 * Same as `HabitData`, for `journal_keys` (issue #338, ADR-0015). `envelope` carries
 * the `Envelope` shape from src/crypto/envelope.ts (kdfParams/wrappedDek/nonce) —
 * reused as `unknown` here so this file, like the sync engine itself, stays
 * content-blind and never imports crypto runtime code.
 */
export interface JournalKeysData {
  envelope: unknown;
}

export interface Mutation {
  /** UUIDv7. Idempotency key — replaying a mutation must not change the outcome. */
  id: string;
  table: SyncTable;
  /** UUIDv7 of the affected row, generated on the client. */
  rowId: string;
  /** `restore` clears `deleted_at` — the only way to undo a swipe-to-delete. */
  op: 'upsert' | 'delete' | 'restore';
  /**
   * Only the fields this mutation actually changed. A partial payload is what lets
   * two devices edit different fields of the same row without clobbering each other.
   * For `tasks`, this is also how nesting travels: `parentId` (uuid or `null`) rides
   * along in this generic payload — no structural change needed here (issue #89).
   */
  payload: Record<string, unknown>;
  /** ISO. Display/tiebreaker only — no longer the conflict authority (ADR-0008). */
  updatedAt: string;
  /**
   * `syncSeq` of the row version this mutation was based on, `null` for a new row.
   * Lets the server detect — independent of any client clock — whether this write
   * overwrites a change from another device that it never saw (ADR-0008).
   */
  baseSeq: number | null;
}

export interface OutboxEntry extends Mutation {
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface PushRequest {
  mutations: Mutation[];
}

export interface PushConflict {
  mutationId: string;
  rowId: string;
  /** This write overwrote a change it never saw. Informative, never silent (ADR-0001). */
  reason: 'overwritten';
  incomingUpdatedAt: string;
  /** `updatedAt` of the row version that got overwritten. */
  overwrittenUpdatedAt: string;
}

export interface PushRejection {
  mutationId: string;
  /** Why this mutation was dropped. Retrying will not help either way — this is a bug. */
  reason?: 'missing-required' | 'malformed' | 'read-only';
  /** NOT NULL columns a create was missing, or the malformed fields' names. */
  missing: string[];
}

export interface PushResponse {
  /**
   * Mutation ids that were applied — including the conflicted ones (arrival wins,
   * ADR-0008). Safe to drop from the outbox.
   */
  applied: string[];
  /** Informative subset of `applied` that overwrote an unseen change. Never silently dropped. */
  conflicts: PushConflict[];
  /** Malformed creates. Dropped from the queue — retrying forever would just wedge it. */
  rejected: PushRejection[];
}

/** A row as it travels from server to client. */
export interface ChangeRow {
  table: SyncTable;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Arrival order (ADR-0008) — what the client's pull cursor advances by. */
  syncSeq: number;
  data: Record<string, unknown>;
}

export interface PullResponse {
  changes: ChangeRow[];
  /** Highest `syncSeq` among the returned changes — the cursor for the next pull. */
  cursor: number;
}
