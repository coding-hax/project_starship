import { metEarlierInPeriod, toDateKey } from '@/features/habits/due-today';
import { isDoneOnDay } from '@/features/habits/schedule-rules';
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
 * dueTodayOnly` (issue #87/#228), Routinen über `schedule-rules.ts`
 * (issue #243, verallgemeinert auf beliebige Perioden in #509). Ein
 * abgeschaltetes Modul (`isActive`, ADR-0012) trägt nichts bei, archivierte
 * Routinen zählen nie mit (wie `HabitToday`). Eine Routine, deren
 * `target` an einem früheren Tag ihrer laufenden Periode schon erreicht wurde,
 * fällt ganz aus Zähler und Nenner heraus (issue #503, #509) —
 * `metEarlierInPeriod`, damit eine heute abgehakte Routine im Ring stehen
 * bleibt statt rückwärts zu springen.
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
    const dateKey = toDateKey(now);
    const dueHabits = habits.filter(
      (habit) => habit.archivedAt === null && !metEarlierInPeriod(habit, logs, now),
    );
    total += dueHabits.length;
    done += dueHabits.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).length;
  }

  return { done, total };
}
