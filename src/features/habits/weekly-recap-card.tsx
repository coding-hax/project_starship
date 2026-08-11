'use client';

import { useBlockReady } from '@/ui/overview-ready';
import { computeWeeklyRecap, type Superlative } from './weekly-recap';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

function superlativeText(superlative: Superlative): string {
  switch (superlative.kind) {
    case 'best-ever':
      return 'Deine beste Woche';
    case 'best-since':
      return `Beste Woche seit ${superlative.weeks} Wochen`;
    case 'tied-with-last-week':
      return 'So viel wie letzte Woche';
  }
}

/**
 * "Wochenrückblick" (issue #431, M-2 aus #416): reine Rückschau auf die
 * zuletzt abgeschlossene Mo–So-Woche, ausschließlich gegen die eigene
 * Historie (docs/VISION.md, nie ein Vergleich mit anderen). Rendert nichts
 * während des Ladens und nichts, sobald geladen aber ohne aktive
 * Gewohnheiten in der Bezugswoche (AC6) — kein Layout-Shift, kein Spinner.
 *
 * Beide „nichts" sehen von außen gleich aus, sind es aber nicht: das eine wird zu
 * Inhalt, das andere bleibt leer. `useBlockReady` meldet genau diesen Unterschied
 * an die Übersicht, damit sie erst zeigt, wenn er entschieden ist (issue #642).
 */
export function WeeklyRecapCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  useBlockReady(habits !== undefined && logs !== undefined);

  if (habits === undefined || logs === undefined) return null;

  const recap = computeWeeklyRecap(habits, logs);
  if (recap === null) return null;

  return (
    <div className="weekly-recap-card">
      <p className="weekly-recap-card__heading">Wochenrückblick</p>
      <p className="weekly-recap-card__metric">
        {recap.metric.met} von {recap.metric.total}
      </p>
      {recap.superlative && (
        <p className="weekly-recap-card__superlative">{superlativeText(recap.superlative)}</p>
      )}
    </div>
  );
}
