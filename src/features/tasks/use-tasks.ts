import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';

/**
 * The subset of a task a read-only list needs. Field names match what the sync
 * engine writes into `LocalRecord.data` (SYNC_REGISTRY['tasks'].writable).
 */
export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: number;
  completedAt: string | null;
}

export function toTaskView(id: string, data: Record<string, unknown>): TaskView {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    notes: typeof data.notes === 'string' ? data.notes : null,
    dueAt: typeof data.dueAt === 'string' ? data.dueAt : null,
    priority: typeof data.priority === 'number' ? data.priority : 0,
    completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
  };
}

/**
 * Open tasks first (sorted by due date, undated last), completed tasks below —
 * regardless of due date, so "done" always reads as done.
 */
export function compareTasks(a: TaskView, b: TaskView): number {
  const aDone = a.completedAt !== null;
  const bDone = b.completedAt !== null;
  if (aDone !== bDone) return aDone ? 1 : -1;

  if (a.dueAt === null && b.dueAt === null) return 0;
  if (a.dueAt === null) return 1;
  if (b.dueAt === null) return -1;
  return a.dueAt.localeCompare(b.dueAt);
}

/**
 * Reads straight from IndexedDB (CLAUDE.md rule 8) — never a `fetch`. `liveQuery`
 * re-runs the query and re-renders whenever a mutation or a pull touches `tasks`,
 * so the list stays current without any explicit refresh.
 *
 * `undefined` while the first read is in flight, then always an array — empty
 * included, so the list can tell "still reading" apart from "no tasks".
 */
export function useTasks(): TaskView[] | undefined {
  const [tasks, setTasks] = useState<TaskView[] | undefined>(undefined);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.records.where('table').equals('tasks').toArray(),
    ).subscribe({
      next: (records) => {
        const visible = records
          .filter((record) => record.deletedAt === null)
          .map((record) => toTaskView(record.id, record.data));
        setTasks(visible.sort(compareTasks));
      },
      error: (error) => console.error('[tasks] live query failed', error),
    });

    return () => subscription.unsubscribe();
  }, []);

  return tasks;
}
