import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from './dexie';
import type { SyncTable } from './types';

/**
 * Reads straight from IndexedDB (CLAUDE.md rule 8) — never a `fetch`. `liveQuery`
 * re-runs whenever a mutation or a pull touches `table`, so the caller stays
 * current without any explicit refresh. Shared by the `records`-backed feature
 * hooks (tasks, habits, habit_logs — see use-tasks.ts, use-habits.ts,
 * use-habit-logs.ts), which differed only in `table`, `toView` and the sort.
 *
 * `undefined` while the first read is in flight, then always an array — empty
 * included, so a caller can tell "still reading" apart from "no rows". Without
 * `compare`, rows come back in whatever order Dexie returned them (matches the
 * pre-refactor `use-habit-logs.ts`, which never sorted).
 */
export function useLiveTable<T>(
  table: SyncTable,
  toView: (id: string, data: Record<string, unknown>) => T,
  compare?: (a: T, b: T) => number,
): T[] | undefined {
  const [rows, setRows] = useState<T[] | undefined>(undefined);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.records.where('table').equals(table).toArray(),
    ).subscribe({
      next: (records) => {
        const visible = records
          .filter((record) => record.deletedAt === null)
          .map((record) => toView(record.id, record.data));
        setRows(compare ? visible.sort(compare) : visible);
      },
      error: (error) => console.error(`[${table}] live query failed`, error),
    });

    return () => subscription.unsubscribe();
  }, [table, toView, compare]);

  return rows;
}
