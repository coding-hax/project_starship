import { useLiveTable } from '@/local/use-live-table';

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

/** Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). */
export function useHabits(): HabitView[] | undefined {
  return useLiveTable('habits', toHabitView, compareHabits);
}
