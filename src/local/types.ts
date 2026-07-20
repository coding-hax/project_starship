/**
 * The wire contract between the client outbox and /api/sync.
 * Shared by both sides so the shapes cannot drift apart.
 */

/** Tables the sync engine is allowed to touch. */
export const SYNC_TABLES = ['sync_state', 'tasks', 'habits', 'habit_logs'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export function isSyncTable(value: unknown): value is SyncTable {
  return typeof value === 'string' && (SYNC_TABLES as readonly string[]).includes(value);
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
  /** NOT NULL columns a create was missing. Retrying will not help — this is a bug. */
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
