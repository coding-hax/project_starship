'use client';

import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import type { TaskView } from './use-tasks';

const UNDO_TIMEOUT_MS = 5000;

interface UndoState {
  taskId: string;
  title: string;
  /** Ids of children tombstoned alongside the parent (issue #89) — empty for a
   *  leaf delete. Drives both the toast's child count and what undo restores. */
  childIds: string[];
}

/**
 * Tombstone the row, then offer a window to reverse it. `restore` is the only op
 * that clears `deleted_at` — a plain `upsert` after a delete would keep it set
 * (src/local/outbox.ts preserves an existing tombstone on upsert), so undo cannot
 * be built from the same primitive `useCompleteTask` uses.
 *
 * Deleting a parent tombstones its children too (issue #89) — a subtask cannot be
 * left dangling under a deleted parent. `children` is optional and defaults to
 * empty so a leaf delete (the common case) is unchanged.
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
    async (task: TaskView, children: TaskView[] = []) => {
      await mutate({ table: 'tasks', rowId: task.id, op: 'delete' });
      for (const child of children) {
        await mutate({ table: 'tasks', rowId: child.id, op: 'delete' });
      }

      clearPendingTimeout();
      setUndo({ taskId: task.id, title: task.title, childIds: children.map((c) => c.id) });
      timeoutRef.current = setTimeout(dismissUndo, UNDO_TIMEOUT_MS);
    },
    [clearPendingTimeout, dismissUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const { taskId, childIds } = undo;
    dismissUndo();
    await mutate({ table: 'tasks', rowId: taskId, op: 'restore' });
    for (const childId of childIds) {
      await mutate({ table: 'tasks', rowId: childId, op: 'restore' });
    }
  }, [undo, dismissUndo]);

  return { deleteTask, undo, handleUndo, dismissUndo };
}
