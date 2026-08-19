'use client';

import { useCallback } from 'react';
import { mutate } from '@/local/outbox';
import type { TaskView } from './use-tasks';

/**
 * Toggling is one `mutate()` call either way — going back to open is just
 * another upsert, the same as editing any other field twice. The outbox applies
 * mutations in order and the server is last-write-wins on `updated_at` (ADR-0001 §3),
 * so two sequential upserts for the same row converge correctly.
 */
export function useCompleteTask() {
  const toggleComplete = useCallback(async (task: TaskView) => {
    const nextCompletedAt = task.completedAt ? null : new Date().toISOString();

    await mutate({
      table: 'tasks',
      rowId: task.id,
      op: 'upsert',
      payload: { completedAt: nextCompletedAt },
    });
  }, []);

  return { toggleComplete };
}
