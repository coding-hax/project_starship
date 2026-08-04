import { useLiveTable } from '@/local/use-live-table';

export type HabitSchedule =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'custom';

const SCHEDULES: HabitSchedule[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
  'custom',
];

/**
 * The subset of a habit a read-only list needs. Field names match what the sync
 * engine writes into `LocalRecord.data` (SYNC_REGISTRY['habits'].writable).
 */
export interface HabitView {
  id: string;
  name: string;
  schedule: HabitSchedule;
  /** How often per period, >= 1. Only > 1 for `weekly` (issue #509). */
  target: number;
  color: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export function toHabitView(id: string, data: Record<string, unknown>): HabitView {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    schedule: SCHEDULES.includes(data.schedule as HabitSchedule)
      ? (data.schedule as HabitSchedule)
      : 'daily',
    target: typeof data.target === 'number' ? data.target : 1,
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
