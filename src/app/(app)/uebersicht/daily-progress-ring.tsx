'use client';

import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useModules } from '@/features/settings/use-modules';
import { useTasks } from '@/features/tasks/use-tasks';
import './daily-progress-ring.css';
import { computeDailyProgress, type DailyProgress } from './daily-progress';

const RADIUS = 14.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatOpen(open: DailyProgress['open']): string {
  const parts: string[] = [];
  if (open.aufgaben > 0) {
    parts.push(`${open.aufgaben} ${open.aufgaben === 1 ? 'Aufgabe' : 'Aufgaben'}`);
  }
  if (open.routinen > 0) {
    parts.push(`${open.routinen} ${open.routinen === 1 ? 'Routine' : 'Routinen'}`);
  }
  return parts.length === 0 ? 'Alles erledigt' : `Offen: ${parts.join(', ')}`;
}

/**
 * Tages-Fortschrittsring in der Augenbrauenzeile von /uebersicht (issue #428,
 * M-1 aus #416, in die Titelzeile verschoben in #652, in die Augenbrauenzeile
 * verkleinert in #920): „N von M" aus Aufgaben + Routinen, modulübergreifend —
 * deshalb im Übersicht-Rahmen (page.tsx) statt in der per-Modul-
 * `OverviewSection`-Registry. Rendert `null`, bis alle drei Live-Queries durch
 * sind, und bei M = 0 dauerhaft (ruhiger Leerzustand statt „0 von 0").
 *
 * Sitzt in einem von `page.tsx` fest bemessenen Slot (`.daily-progress-ring-slot`,
 * 34×34px) — der Slot, nicht dieser Wechsel zwischen `null` und Inhalt, hält die
 * Augenbrauenzeile stabil, also kein `useBlockReady` nötig: die Augenbrauenzeile
 * steht bewusst außerhalb von `OverviewReadyProvider` (issue #642) und ein
 * Beitritt dort würde sie selbst verzögern statt sie stabil zu halten.
 *
 * Ab 1440px verschwindet dieser Ring (uebersicht.css) zugunsten von
 * `DailyProgressPill` unten, die dieselbe Zahl im Zusatz-Slot der Kopfzeile
 * zeigt (issue #1180, Nachfolger von #1122).
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
        viewBox="0 0 34 34"
        width="34"
        height="34"
        aria-hidden="true"
      >
        <circle
          className="daily-progress-ring__track"
          cx="17"
          cy="17"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
        />
        <circle
          className="daily-progress-ring__fill"
          cx="17"
          cy="17"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 17 17)"
        />
        <text
          className="daily-progress-ring__count"
          x="17"
          y="17"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {done}/{total}
        </text>
      </svg>
    </div>
  );
}

/**
 * Zählpille im Zusatz-Slot der Kopfzeile, sichtbar erst ab 1440px
 * (uebersicht.css blendet `.page-head__extra` für /uebersicht darunter aus) —
 * löst dort den Segmentring aus #1122 ab (issue #1180 AK3). Eigene
 * Live-Queries statt eines gemeinsamen Hooks mit `DailyProgressRing`: beide
 * Bauteile stehen in verschiedenen Zonen der Kopfzeile (Augenbraue vs.
 * Zusatz-Slot), dieselbe Unabhängigkeit wie anderswo im Übersicht-Rahmen
 * (z. B. `aufgaben-count.tsx` neben `task-list.tsx`).
 */
export function DailyProgressPill() {
  const tasks = useTasks();
  const habits = useHabits();
  const logs = useHabitLogs();
  const { isActive } = useModules();

  if (tasks === undefined || habits === undefined || logs === undefined) return null;

  const { done, total, open } = computeDailyProgress(tasks, habits, logs, isActive);
  if (total === 0) return null;

  return (
    <div
      className="daily-progress-pill"
      role="status"
      aria-label={`heute ${done} von ${total} erledigt, ${formatOpen(open)}`}
    >
      <span className="daily-progress-pill__count">
        {done} von {total} erledigt
      </span>
      <span className="daily-progress-pill__breakdown">{formatOpen(open)}</span>
    </div>
  );
}
