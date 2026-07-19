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
  createdAt: string;
  /** Nesting (issue #89). `null` means top-level. One level only — a child's own
   *  `parentId` is never read as a further nesting level. */
  parentId: string | null;
}

export function toTaskView(id: string, data: Record<string, unknown>): TaskView {
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    notes: typeof data.notes === 'string' ? data.notes : null,
    dueAt: typeof data.dueAt === 'string' ? data.dueAt : null,
    priority: typeof data.priority === 'number' ? data.priority : 0,
    completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
    // Falls back to the epoch, not "now" — a record pulled without a createdAt
    // (pre-#88 server row) sorts to the top of the running list rather than
    // jumping to the bottom on every reload.
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
  };
}

/**
 * Strictly chronological — a running list (issue #88). New tasks land at the
 * bottom, completed ones stay exactly where they were created; "done" is shown
 * via styling (task-list__item--done), never by moving the row.
 */
export function compareTasks(a: TaskView, b: TaskView): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export interface TaskNode {
  task: TaskView;
  children: TaskView[];
  done: number;
  total: number;
}

/**
 * Groups the flat task list into one level of parent/child nesting (issue #89).
 * A task whose `parentId` points at a row that is not in the list (deleted, or
 * never arrived) falls back to top-level rather than vanishing — a visible child
 * must never be orphaned into nothing.
 */
export function groupTasks(tasks: TaskView[]): TaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, TaskView[]>();

  for (const task of tasks) {
    if (task.parentId === null || !byId.has(task.parentId)) continue;
    const siblings = childrenByParent.get(task.parentId) ?? [];
    siblings.push(task);
    childrenByParent.set(task.parentId, siblings);
  }

  return tasks
    .filter((task) => task.parentId === null || !byId.has(task.parentId))
    .sort(compareTasks)
    .map((task) => {
      const children = (childrenByParent.get(task.id) ?? []).sort(compareTasks);
      return {
        task,
        children,
        done: children.filter((child) => child.completedAt !== null).length,
        total: children.length,
      };
    });
}

/**
 * Where a drag-to-nest drop lands (issue #89). `null` means top-level — dropping
 * on empty space, on the dragged task itself, or on a target that no longer
 * exists all un-nest rather than error. Dropping on an existing child attaches to
 * *that child's* parent, since a subtask can never itself have children (one
 * level only).
 */
export function resolveNestTarget(
  draggedId: string,
  dropTargetId: string | null,
  tasks: TaskView[],
): string | null {
  if (dropTargetId === null || dropTargetId === draggedId) return null;
  const target = tasks.find((task) => task.id === dropTargetId);
  if (!target) return null;
  return target.parentId !== null ? target.parentId : target.id;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Open, dated tasks due today (local calendar day) or earlier — the /heute
 * dashboard subset (issue #87). Undated tasks and tasks due later than today are
 * excluded, and so is anything already completed.
 */
export function isDueTodayOrOverdue(task: TaskView, now: Date = new Date()): boolean {
  if (task.completedAt !== null || task.dueAt === null) return false;
  const startOfTomorrow = startOfLocalDay(now);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  return new Date(task.dueAt) < startOfTomorrow;
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
