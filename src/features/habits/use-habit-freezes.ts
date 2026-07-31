import { useLiveTable } from '@/local/use-live-table';

/**
 * The subset of a habit_freezes row a streak/UI read needs. Field names match
 * what the sync engine writes into `LocalRecord.data`
 * (SYNC_REGISTRY['habit_freezes'].writable) — same shape as `HabitLogView`,
 * minus `done` (a freeze has no true/false, only whether it exists).
 */
export interface HabitFreezeView {
  id: string;
  habitId: string;
  /** Calendar day, `YYYY-MM-DD` — the day the joker bridges. */
  freezeDate: string;
}

export function toHabitFreezeView(id: string, data: Record<string, unknown>): HabitFreezeView {
  return {
    id,
    habitId: typeof data.habitId === 'string' ? data.habitId : '',
    freezeDate: typeof data.freezeDate === 'string' ? data.freezeDate : '',
  };
}

/** Thin wrapper around the shared `useLiveTable` (src/local/use-live-table.ts). */
export function useHabitFreezes(): HabitFreezeView[] | undefined {
  return useLiveTable('habit_freezes', toHabitFreezeView);
}
