'use client';

import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useModules } from '@/features/settings/use-modules';
import { useTasks } from '@/features/tasks/use-tasks';
import { useBlockReady } from '@/ui/overview-ready';
import './daily-progress-ring.css';
import { computeDailyProgress } from './daily-progress';

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Tages-Fortschrittsring auf /uebersicht (issue #428, M-1 aus #416): „heute N
 * von M" aus Aufgaben + Routinen, modulübergreifend — deshalb im
 * Übersicht-Rahmen (page.tsx) statt in der per-Modul-`OverviewSection`-Registry.
 * Rendert `null`, bis alle drei Live-Queries durch sind (kein Layout-Shift,
 * Smooth-Regel 3, gleiches Muster wie `HabitToday`) und bei M = 0 dauerhaft
 * (ruhiger Leerzustand statt „0 von 0").
 *
 * Als oberster Block der Seite schöbe genau dieser Wechsel alles darunter nach
 * unten — `useBlockReady` hängt ihn deshalb an den gemeinsamen
 * Enthüllungspunkt der Übersicht (issue #642).
 */
export function DailyProgressRing() {
  const tasks = useTasks();
  const habits = useHabits();
  const logs = useHabitLogs();
  const { isActive } = useModules();

  useBlockReady(tasks !== undefined && habits !== undefined && logs !== undefined);

  if (tasks === undefined || habits === undefined || logs === undefined) return null;

  const { done, total } = computeDailyProgress(tasks, habits, logs, isActive);
  if (total === 0) return null;

  const fraction = done / total;
  const offset = CIRCUMFERENCE * (1 - fraction);

  return (
    <div className="daily-progress-ring" role="status">
      <svg
        className="daily-progress-ring__svg"
        viewBox="0 0 48 48"
        width="48"
        height="48"
        aria-hidden="true"
      >
        <circle
          className="daily-progress-ring__track"
          cx="24"
          cy="24"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
        />
        <circle
          className="daily-progress-ring__fill"
          cx="24"
          cy="24"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 24 24)"
        />
      </svg>
      <span className="daily-progress-ring__label">
        heute {done} von {total}
      </span>
    </div>
  );
}
