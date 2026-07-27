import { and, asc, desc, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { tasks, type Task } from '@/db/schema';
import { berlinNow } from '@/push/schedule';
import type { PushPayload } from '@/push/send';
import type { ReminderKind } from './index';

/**
 * Same "today or overdue" semantics as the overdue highlight (issue #86): a task's
 * own `dueAt` maps to its Berlin calendar day (`berlinNow`, DST-safe), "due" means
 * that day is today's Berlin day or earlier.
 */
function isDueTodayOrEarlier(dueAt: Date, now: Date): boolean {
  return berlinNow(dueAt).dateKey <= berlinNow(now).dateKey;
}

/**
 * Pure so the exclusion rules (done/tombstoned/not-yet-due) are Vitest-testable
 * without a database — the `where()` below already narrows the same way, this is
 * the belt to its braces.
 */
export function selectDueTasks(candidates: Task[], now: Date): Task[] {
  return candidates.filter(
    (task) =>
      task.dueAt !== null &&
      task.completedAt === null &&
      task.deletedAt === null &&
      isDueTodayOrEarlier(task.dueAt, now),
  );
}

function buildBody(dueTasks: Task[]): string {
  if (dueTasks.length === 1) return dueTasks[0].title;
  const shown = dueTasks.slice(0, 2).map((task) => task.title);
  const remaining = dueTasks.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} und ${remaining} weitere` : shown.join(', ');
}

export async function build(now: Date): Promise<PushPayload | null> {
  const candidates = await db
    .select()
    .from(tasks)
    .where(and(isNotNull(tasks.dueAt), isNull(tasks.completedAt), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.priority), asc(tasks.dueAt));

  const due = selectDueTasks(candidates, now);
  if (due.length === 0) return null;

  const title = due.length === 1 ? 'Heute fällig' : `${due.length} Aufgaben heute fällig`;

  return { title, body: buildBody(due), url: '/aufgaben' };
}

export const tasksDue: ReminderKind = { kind: 'tasks-due', times: ['07:00'], build };
