'use client';

import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import type { HabitView } from './use-habits';

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  habitId: string;
  name: string;
}

/**
 * Archiving is `archivedAt` set/cleared, not a tombstone — the AC is explicit that
 * the streak history must survive it, so this never touches `deletedAt`. Toggling
 * is one `mutate()` either way, same reasoning as use-complete-task.ts: two
 * sequential upserts converge correctly, nothing to cancel.
 */
export function useArchiveHabit() {
  const [undo, setUndo] = useState<UndoState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismissUndo = useCallback(() => {
    clearPendingTimeout();
    setUndo(null);
  }, [clearPendingTimeout]);

  const toggleArchive = useCallback(
    async (habit: HabitView) => {
      const nextArchivedAt = habit.archivedAt ? null : new Date().toISOString();

      await mutate({
        table: 'habits',
        rowId: habit.id,
        op: 'upsert',
        payload: { archivedAt: nextArchivedAt },
      });

      clearPendingTimeout();

      if (nextArchivedAt) {
        setUndo({ habitId: habit.id, name: habit.name });
        timeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
      } else {
        // Reactivating is itself the corrective action — no undo offer for it.
        setUndo(null);
      }
    },
    [clearPendingTimeout, dismissUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { habitId } = undo;
    dismissUndo();
    await mutate({ table: 'habits', rowId: habitId, op: 'upsert', payload: { archivedAt: null } });
  }, [undo, dismissUndo]);

  return { toggleArchive, undo, handleUndo, dismissUndo };
}
