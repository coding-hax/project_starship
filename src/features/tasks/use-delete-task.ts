'use client';

import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import type { TaskView } from './use-tasks';

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  taskId: string;
  title: string;
}

/**
 * Tombstone the row, then offer a window to reverse it. `restore` is the only op
 * that clears `deleted_at` — a plain `upsert` after a delete would keep it set
 * (src/local/outbox.ts preserves an existing tombstone on upsert), so undo cannot
 * be built from the same primitive `useCompleteTask` uses.
 */
export function useDeleteTask() {
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

  const deleteTask = useCallback(
    async (task: TaskView) => {
      await mutate({ table: 'tasks', rowId: task.id, op: 'delete' });

      clearPendingTimeout();
      setUndo({ taskId: task.id, title: task.title });
      timeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
    },
    [clearPendingTimeout, dismissUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { taskId } = undo;
    dismissUndo();
    await mutate({ table: 'tasks', rowId: taskId, op: 'restore' });
  }, [undo, dismissUndo]);

  return { deleteTask, undo, handleUndo, dismissUndo };
}
