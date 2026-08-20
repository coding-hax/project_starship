'use client';

import { useBlockReady } from '@/ui/overview-ready';
import { countHabitsOnStreak } from './streak';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

/**
 * "Routinen in Serie" (issue #809, löst den alten Wochenrückblick ab): zeigt,
 * wie viele nicht archivierten Routinen gerade eine laufende Serie haben
 * (Serie ≥ 1, deckungsgleich mit dem Streak-Badge in der Liste). Rendert
 * nichts während des Ladens und nichts ohne jede aktive Routine — kein
 * Layout-Shift, kein Spinner.
 *
 * Beide „nichts" sehen von außen gleich aus, sind es aber nicht: das eine wird zu
 * Inhalt, das andere bleibt leer. `useBlockReady` meldet genau diesen Unterschied
 * an die Übersicht, damit sie erst zeigt, wenn er entschieden ist (issue #642).
 */
export function StreakSummaryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  useBlockReady(habits !== undefined && logs !== undefined);

  if (habits === undefined || logs === undefined) return null;

  const activeHabits = habits.filter((habit) => habit.archivedAt === null);
  if (activeHabits.length === 0) return null;

  const count = countHabitsOnStreak(habits, logs);

  return (
    <div className="streak-summary-card">
      <p className="streak-summary-card__heading">Routinen in Serie</p>
      <p className="streak-summary-card__metric">{count}</p>
      {count === 0 && <p className="streak-summary-card__hint">Gerade läuft keine Serie</p>}
    </div>
  );
}
