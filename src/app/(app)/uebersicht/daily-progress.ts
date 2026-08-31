import { computeHabitProgress } from '@/features/habits/habit-progress';
import type { HabitLogView } from '@/features/habits/use-habit-logs';
import type { HabitView } from '@/features/habits/use-habits';
import { belongsOnUebersicht, type TaskView } from '@/features/tasks/use-tasks';

export interface DailyProgress {
  done: number;
  total: number;
}

/**
 * "heute N von M" (issue #428, M-1 aus #416) — reine Zählung über die schon
 * vorhandenen Modul-Definitionen von „fällig"/„erledigt", keine eigene Logik:
 * Aufgaben über dieselbe `belongsOnUebersicht`-Regel wie `TaskList
 * dueTodayOnly` (issue #87/#228), Routinen über `computeHabitProgress`
 * (issue #972, vorher hier inline berechnet — jetzt geteilt mit dem
 * Routinen-Kartenkopf-Link, damit Ring und Link nie auseinanderdriften). Ein
 * abgeschaltetes Modul (`isActive`, ADR-0012) trägt nichts bei.
 */
export function computeDailyProgress(
  tasks: TaskView[],
  habits: HabitView[],
  logs: HabitLogView[],
  isActive: (id: string) => boolean,
  now: Date = new Date(),
): DailyProgress {
  let done = 0;
  let total = 0;

  if (isActive('aufgaben')) {
    const dueTasks = tasks.filter((task) => belongsOnUebersicht(task, now));
    total += dueTasks.length;
    done += dueTasks.filter((task) => task.completedAt !== null).length;
  }

  if (isActive('routinen')) {
    const habitProgress = computeHabitProgress(habits, logs, now);
    total += habitProgress.total;
    done += habitProgress.done;
  }

  return { done, total };
}
