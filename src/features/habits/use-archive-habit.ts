'use client';

import { useCallback } from 'react';
import { mutate } from '@/local/outbox';
import type { HabitView } from './use-habits';

/**
 * Archiving is `archivedAt` set/cleared, not a tombstone — the AC is explicit that
 * the streak history must survive it, so this never touches `deletedAt`. Toggling
 * is one `mutate()` either way, same reasoning as use-complete-task.ts: two
 * sequential upserts converge correctly.
 */
export function useArchiveHabit() {
  const toggleArchive = useCallback(async (habit: HabitView) => {
    const nextArchivedAt = habit.archivedAt ? null : new Date().toISOString();

    await mutate({
      table: 'habits',
      rowId: habit.id,
      op: 'upsert',
      payload: { archivedAt: nextArchivedAt },
    });
  }, []);

  return { toggleArchive };
}
