import { habitsDueToday } from '@/features/habits/due-today';
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
 * dueTodayOnly` (issue #87/#228), Routinen über `habitsDueToday`
 * (due-today.ts) — dieselbe Funktion, die auch der Statusblock-Ring auf
 * /routinen nutzt (issue #863, AK5: eine Wahrheit je Frage). Ein
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
    const habitsProgress = habitsDueToday(habits, logs, now);
    total += habitsProgress.due;
    done += habitsProgress.done;
  }

  return { done, total };
}
