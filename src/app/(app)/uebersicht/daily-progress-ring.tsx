'use client';

import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useModules } from '@/features/settings/use-modules';
import { useTasks } from '@/features/tasks/use-tasks';
import './daily-progress-ring.css';
import { computeDailyProgress } from './daily-progress';

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Tages-Fortschrittsring in der Titelzeile von /uebersicht (issue #428, M-1 aus
 * #416, in die Titelzeile verschoben in #652): „N von M" aus Aufgaben +
 * Routinen, modulübergreifend — deshalb im Übersicht-Rahmen (page.tsx) statt in
 * der per-Modul-`OverviewSection`-Registry. Rendert `null`, bis alle drei
 * Live-Queries durch sind, und bei M = 0 dauerhaft (ruhiger Leerzustand statt
 * „0 von 0").
 *
 * Sitzt in einem von `page.tsx` fest bemessenen Slot (`.daily-progress-ring-slot`,
 * 48×48px) — der Slot, nicht dieser Wechsel zwischen `null` und Inhalt, hält die
 * Titelzeile stabil, also kein `useBlockReady` nötig: die Titelzeile steht
 * bewusst außerhalb von `OverviewReadyProvider` (issue #642) und ein Beitritt
 * dort würde sie selbst verzögern statt sie stabil zu halten.
 */
export function DailyProgressRing() {
  const tasks = useTasks();
  const habits = useHabits();
  const logs = useHabitLogs();
  const { isActive } = useModules();

  if (tasks === undefined || habits === undefined || logs === undefined) return null;

  const { done, total } = computeDailyProgress(tasks, habits, logs, isActive);
  if (total === 0) return null;

  const fraction = done / total;
  const offset = CIRCUMFERENCE * (1 - fraction);

  return (
    <div
      className="daily-progress-ring"
      role="status"
      aria-label={`heute ${done} von ${total} erledigt`}
    >
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
        <text
          className="daily-progress-ring__count"
          x="24"
          y="24"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {done}/{total}
        </text>
      </svg>
    </div>
  );
}
