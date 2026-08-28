'use client';

import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useModules } from '@/features/settings/use-modules';
import { useTasks } from '@/features/tasks/use-tasks';
import { computeDailyProgress } from './daily-progress';

/**
 * Unterzeile im PageHead-Zusatz-Slot von /uebersicht (issue #868, AK4): „was
 * heute noch offen ist" — dieselbe Zählung wie `DailyProgressRing`. Rendert
 * nichts, solange die drei Live-Queries noch laufen oder M = 0 ist (kein
 * Leerzustand-Text, wenn an diesem Tag gar nichts fällig ist).
 */
export function UebersichtSubline() {
  const tasks = useTasks();
  const habits = useHabits();
  const logs = useHabitLogs();
  const { isActive } = useModules();

  if (tasks === undefined || habits === undefined || logs === undefined) return null;

  const { done, total } = computeDailyProgress(tasks, habits, logs, isActive);
  if (total === 0) return null;

  const label =
    done >= total ? 'Alles erledigt für heute' : `Noch ${total - done} von ${total} offen`;

  return <p className="page-head__subline">{label}</p>;
}
