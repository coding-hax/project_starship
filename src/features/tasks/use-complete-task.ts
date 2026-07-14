'use client';

import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import type { TaskView } from './use-tasks';

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  taskId: string;
  title: string;
  /** What to restore `completedAt` to if the toast is tapped. */
  previousCompletedAt: string | null;
}

/**
 * Toggling is one `mutate()` call either way — going back to open on undo is just
 * another upsert, the same as editing any other field twice. The outbox applies
 * mutations in order and the server is last-write-wins on `updated_at` (ADR-0001 §3),
 * so two sequential upserts for the same row converge correctly; there is nothing to
 * cancel.
 */
export function useCompleteTask() {
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

  const toggleComplete = useCallback(
    async (task: TaskView) => {
      const previousCompletedAt = task.completedAt;
      const nextCompletedAt = previousCompletedAt ? null : new Date().toISOString();

      await mutate({
        table: 'tasks',
        rowId: task.id,
        op: 'upsert',
        payload: { completedAt: nextCompletedAt },
      });

      clearPendingTimeout();

      if (nextCompletedAt) {
        setUndo({ taskId: task.id, title: task.title, previousCompletedAt });
        timeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
      } else {
        // Toggling back open is the corrective action itself — no undo needed for it.
        setUndo(null);
      }
    },
    [clearPendingTimeout, dismissUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { taskId, previousCompletedAt } = undo;
    dismissUndo();
    await mutate({
      table: 'tasks',
      rowId: taskId,
      op: 'upsert',
      payload: { completedAt: previousCompletedAt },
    });
  }, [undo, dismissUndo]);

  return { toggleComplete, undo, handleUndo, dismissUndo };
}
