import type { SyncTable } from '@/local/types';
import { syncState, tasks } from './schema';

/**
 * The only tables the sync engine may touch, and the only fields a client may write.
 *
 * The whitelist is not a formality: without it a mutation could set `id` or
 * `updated_at` itself and walk straight through last-write-wins.
 *
 * `required` are the NOT NULL columns without a default. A mutation that creates a
 * row must carry them, or the insert dies at the database with a 500. We'd rather
 * reject it at the door with a 400.
 */
export const SYNC_REGISTRY = {
  sync_state: {
    table: syncState,
    writable: ['key', 'value'],
    required: ['key', 'value'],
  },
  tasks: {
    table: tasks,
    writable: ['title', 'notes', 'dueAt', 'priority', 'completedAt', 'recurrenceRule'],
    required: ['title'],
  },
} as const satisfies Record<
  SyncTable,
  { table: unknown; writable: readonly string[]; required: readonly string[] }
>;

/** Strips everything the client is not allowed to set. */
export function writableFields(
  table: SyncTable,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const entry = SYNC_REGISTRY[table];
  const allowed = entry.writable as readonly string[];
  const columns = entry.table as unknown as Record<string, { dataType?: string }>;
  const out: Record<string, unknown> = {};
  for (const field of allowed) {
    if (!(field in payload)) continue;
    const value = payload[field];
    // The wire format is JSON, so a timestamp column's value arrives as an ISO
    // string — drizzle's `timestamp` columns need an actual Date to insert/update.
    out[field] =
      typeof value === 'string' && columns[field]?.dataType === 'date' ? new Date(value) : value;
  }
  return out;
}

/** Fields a create is missing. Empty means the insert is safe to attempt. */
export function missingRequired(table: SyncTable, fields: Record<string, unknown>): string[] {
  const required = SYNC_REGISTRY[table].required as readonly string[];
  return required.filter((field) => !(field in fields));
}
