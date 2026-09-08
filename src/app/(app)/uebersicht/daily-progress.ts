import { computeHabitProgress } from '@/features/habits/habit-progress';
import type { HabitLogView } from '@/features/habits/use-habit-logs';
import type { HabitView } from '@/features/habits/use-habits';
import { belongsOnUebersicht, type TaskView } from '@/features/tasks/use-tasks';

export interface DailyProgress {
  done: number;
  total: number;
  /** Offene Menge je Art (issue #1122) — 0 für ein abgeschaltetes Modul. */
  open: { aufgaben: number; routinen: number };
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
  let openAufgaben = 0;
  let openRoutinen = 0;

  if (isActive('aufgaben')) {
    const dueTasks = tasks.filter((task) => belongsOnUebersicht(task, now));
    const doneTasks = dueTasks.filter((task) => task.completedAt !== null).length;
    total += dueTasks.length;
    done += doneTasks;
    openAufgaben = dueTasks.length - doneTasks;
  }

  if (isActive('routinen')) {
    const habitProgress = computeHabitProgress(habits, logs, now);
    total += habitProgress.total;
    done += habitProgress.done;
    openRoutinen = habitProgress.total - habitProgress.done;
  }

  return { done, total, open: { aufgaben: openAufgaben, routinen: openRoutinen } };
}
