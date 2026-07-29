import type { SyncTable } from '@/local/types';
import {
  garminActivities,
  habitLogs,
  habits,
  journalEntries,
  journalKeys,
  reminderPrefs,
  syncState,
  tasks,
} from './schema';

/**
 * The only tables the sync engine may touch, and the only fields a client may write.
 *
 * The whitelist is not a formality: without it a mutation could set `id` or
 * `updated_at` itself and walk straight through last-write-wins.
 *
 * `required` are the NOT NULL columns without a default. A mutation that creates a
 * row must carry them, or the insert dies at the database with a 500. We'd rather
 * reject it at the door with a 400.
 *
 * `readOnly` + `readable` mark a table the sync engine only ever pulls from
 * (ADR-0011): `writable`/`required` stay empty on purpose — a table cannot be
 * "read-only but insertable" — and `readable` is the pull projection instead. Never
 * expressed as `writable: []` alone, because that would still let a create/update
 * mutation through with an empty payload and tombstone a row via `deletedAt`; the
 * actual rejection happens in `push`/`outbox.mutate()` via `isReadOnlyTable()`.
 */
export const SYNC_REGISTRY = {
  sync_state: {
    table: syncState,
    writable: ['key', 'value'],
    required: ['key', 'value'],
  },
  tasks: {
    table: tasks,
    writable: [
      'title',
      'notes',
      'dueAt',
      'priority',
      'completedAt',
      'recurrenceRule',
      'createdAt',
      'parentId',
    ],
    required: ['title'],
  },
  habits: {
    table: habits,
    writable: ['name', 'schedule', 'color', 'archivedAt', 'createdAt'],
    required: ['name', 'schedule'],
  },
  habit_logs: {
    table: habitLogs,
    writable: ['habitId', 'logDate', 'done'],
    required: ['habitId', 'logDate'],
  },
  reminder_prefs: {
    table: reminderPrefs,
    writable: ['kind', 'enabled', 'times'],
    required: ['kind'],
  },
  journal_entries: {
    table: journalEntries,
    writable: ['entryDate', 'ciphertext', 'nonce'],
    required: ['entryDate', 'ciphertext', 'nonce'],
  },
  journal_keys: {
    table: journalKeys,
    writable: ['envelope'],
    required: ['envelope'],
  },
  garmin_activities: {
    table: garminActivities,
    writable: [],
    required: [],
    readOnly: true,
    readable: [
      'garminActivityId',
      'activityType',
      'name',
      'startedAt',
      'distanceMeters',
      'durationSeconds',
      'elapsedSeconds',
      'elevationGain',
      'elevationLoss',
      'averageHr',
      'maxHr',
      'averageSpeed',
      'calories',
      'track',
      'mapImage',
      'fetchedAt',
    ],
  },
} as const satisfies Record<
  SyncTable,
  {
    table: unknown;
    writable: readonly string[];
    required: readonly string[];
    readOnly?: boolean;
    readable?: readonly string[];
  }
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
