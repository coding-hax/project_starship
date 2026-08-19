'use client';

import { useCallback } from 'react';
import { mutate } from '@/local/outbox';
import type { TaskView } from './use-tasks';

/**
 * Deleting a parent tombstones its children too (issue #89) — a subtask cannot be
 * left dangling under a deleted parent. `children` is optional and defaults to
 * empty so a leaf delete (the common case) is unchanged.
 */
export function useDeleteTask() {
  const deleteTask = useCallback(async (task: TaskView, children: TaskView[] = []) => {
    await mutate({ table: 'tasks', rowId: task.id, op: 'delete' });
    for (const child of children) {
      await mutate({ table: 'tasks', rowId: child.id, op: 'delete' });
    }
  }, []);

  return { deleteTask };
}
