/**
 * The wire contract between the client outbox and /api/sync.
 * Shared by both sides so the shapes cannot drift apart.
 */

/** Tables the sync engine is allowed to touch. */
export const SYNC_TABLES = ['sync_state', 'tasks'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export function isSyncTable(value: unknown): value is SyncTable {
  return typeof value === 'string' && (SYNC_TABLES as readonly string[]).includes(value);
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
   */
  payload: Record<string, unknown>;
  /** ISO. The logical timestamp last-write-wins compares against. */
  updatedAt: string;
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
  reason: 'stale';
  incomingUpdatedAt: string;
  storedUpdatedAt: string;
}

export interface PushRejection {
  mutationId: string;
  /** NOT NULL columns a create was missing. Retrying will not help — this is a bug. */
  missing: string[];
}

export interface PushResponse {
  /** Mutation ids that were applied or were already applied. Safe to drop from the outbox. */
  applied: string[];
  /** Rejected as older than what the server holds. Logged, never silently dropped. */
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
  data: Record<string, unknown>;
}

export interface PullResponse {
  changes: ChangeRow[];
  /** Server clock at the moment of the read — the cursor for the next pull. */
  now: string;
}
