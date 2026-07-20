'use client';

import { useCallback } from 'react';
import { mutate } from '@/local/outbox';
import type { HabitLogView } from './use-habit-logs';

/**
 * One `mutate()` call either way, same shape as `useCompleteTask` for tasks —
 * looks up today's existing log row (if any) and reuses its id so a second tap
 * upserts that same row instead of racing `UNIQUE(habit_id, log_date)` with a
 * fresh insert (issue #103 AC2). Toggling back is not a separate "undo" path,
 * it is just another upsert; the server is last-write-wins on `updated_at`
 * (ADR-0001 §3), so there is nothing to cancel.
 */
export function useToggleHabitLog(logs: HabitLogView[] | undefined) {
  return useCallback(
    (habitId: string, logDate: string) => {
      const existing = logs?.find((log) => log.habitId === habitId && log.logDate === logDate);
      return mutate({
        table: 'habit_logs',
        rowId: existing?.id,
        op: 'upsert',
        payload: existing ? { done: !existing.done } : { habitId, logDate, done: true },
      });
    },
    [logs],
  );
}
