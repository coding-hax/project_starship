import { useLiveTable } from '@/local/use-live-table';

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
 * Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). No
 * `compare` — matches the pre-refactor behavior, which never sorted `habit_logs`.
 */
export function useHabitLogs(): HabitLogView[] | undefined {
  return useLiveTable('habit_logs', toHabitLogView);
}
