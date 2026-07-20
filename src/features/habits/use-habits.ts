import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';

/**
 * The subset of a habit a read-only list needs. Field names match what the sync
 * engine writes into `LocalRecord.data` (SYNC_REGISTRY['habits'].writable).
 */
export interface HabitView {
  id: string;
  name: string;
  schedule: 'daily' | 'weekly' | 'custom';
  color: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export function toHabitView(id: string, data: Record<string, unknown>): HabitView {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    schedule: data.schedule === 'weekly' || data.schedule === 'custom' ? data.schedule : 'daily',
    color: typeof data.color === 'string' ? data.color : null,
    archivedAt: typeof data.archivedAt === 'string' ? data.archivedAt : null,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
  };
}

/** Oldest first, same running-list convention as tasks (use-tasks.ts). */
export function compareHabits(a: HabitView, b: HabitView): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * Reads straight from IndexedDB (CLAUDE.md rule 8) — never a `fetch`. `liveQuery`
 * re-runs whenever a mutation or a pull touches `habits`, so the management screen
 * stays current without any explicit refresh.
 *
 * `undefined` while the first read is in flight, then always an array — empty
 * included, so the list can tell "still reading" apart from "no habits".
 */
export function useHabits(): HabitView[] | undefined {
  const [habits, setHabits] = useState<HabitView[] | undefined>(undefined);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.records.where('table').equals('habits').toArray(),
    ).subscribe({
      next: (records) => {
        const visible = records
          .filter((record) => record.deletedAt === null)
          .map((record) => toHabitView(record.id, record.data));
        setHabits(visible.sort(compareHabits));
      },
      error: (error) => console.error('[habits] live query failed', error),
    });

    return () => subscription.unsubscribe();
  }, []);

  return habits;
}
