import { toDateKey } from '@/features/habits/due-today';
import { isDoneOnDay, isDueOnDay, weekRangeForDay } from '@/features/habits/schedule-rules';
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
 * dueTodayOnly` (issue #87/#228), Gewohnheiten über `schedule-rules.ts`
 * (issue #243). Ein abgeschaltetes Modul (`isActive`, ADR-0012) trägt nichts
 * bei, archivierte Gewohnheiten zählen nie mit (wie `HabitToday`).
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

  if (isActive('gewohnheiten')) {
    const dateKey = toDateKey(now);
    const weekRange = weekRangeForDay(dateKey);
    const dueHabits = habits.filter(
      (habit) => habit.archivedAt === null && isDueOnDay(habit, dateKey, weekRange),
    );
    total += dueHabits.length;
    done += dueHabits.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).length;
  }

  return { done, total };
}
