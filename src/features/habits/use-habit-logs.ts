import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';

/**
 * The subset of a habit_logs row a read-only check-off list needs. Field names
 * match what the sync engine writes into `LocalRecord.data`
 * (SYNC_REGISTRY['habit_logs'].writable).
 */
export interface HabitLogView {
  id: string;
  habitId: string;
  /** Calendar day, `YYYY-MM-DD` — a streak/due-today check is a day boundary,
   *  never a moment (see `src/db/schema.ts`). */
  logDate: string;
  done: boolean;
}

export function toHabitLogView(id: string, data: Record<string, unknown>): HabitLogView {
  return {
    id,
    habitId: typeof data.habitId === 'string' ? data.habitId : '',
    logDate: typeof data.logDate === 'string' ? data.logDate : '',
    done: typeof data.done === 'boolean' ? data.done : true,
  };
}

/**
 * Reads straight from IndexedDB (CLAUDE.md rule 8) — never a `fetch`. `liveQuery`
 * re-runs whenever a mutation or a pull touches `habit_logs`, so a check-off (this
 * device or another) and a reload both land on the same state without any
 * explicit refresh (issue #103 AC3).
 *
 * `undefined` while the first read is in flight, then always an array — empty
 * included, so callers can tell "still reading" apart from "no logs yet".
 */
export function useHabitLogs(): HabitLogView[] | undefined {
  const [logs, setLogs] = useState<HabitLogView[] | undefined>(undefined);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.records.where('table').equals('habit_logs').toArray(),
    ).subscribe({
      next: (records) => {
        const visible = records
          .filter((record) => record.deletedAt === null)
          .map((record) => toHabitLogView(record.id, record.data));
        setLogs(visible);
      },
      error: (error) => console.error('[habit_logs] live query failed', error),
    });

    return () => subscription.unsubscribe();
  }, []);

  return logs;
}
