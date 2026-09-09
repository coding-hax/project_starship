'use client';

import { useHabitLogs } from '@/features/habits/use-habit-logs';
import { useHabits } from '@/features/habits/use-habits';
import { useModules } from '@/features/settings/use-modules';
import { useTasks } from '@/features/tasks/use-tasks';
import './daily-progress-ring.css';
import { computeDailyProgress, type DailyProgress } from './daily-progress';

const RADIUS = 14.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Ab dieser Menge fälliger Sachen zerfallen einzelne Segmente in Haarstriche —
// ab hier fällt der Wide-Ring auf den Vollring zurück (issue #1122, AK5).
const MAX_SEGMENTS = 24;
const WIDE_RADIUS = 32;
const WIDE_CIRCUMFERENCE = 2 * Math.PI * WIDE_RADIUS;
// Sichtbarer Anteil je Segment auf einer `pathLength={total}`-Skala — der Rest
// (28 %) bleibt Lücke, damit sie zwischen den Segmenten sichtbar bleiben.
const SEGMENT_VISIBLE = 0.72;

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
 * Ab 1440px rendert dieselbe Berechnung zusätzlich ein Geschwister
 * (`.daily-progress-ring-wide`, issue #1122): ein Segment je fälliger Sache
 * statt der kompakten „N/M"-Zahl, mit Klartext-Aufschlüsselung daneben. Beide
 * Varianten stehen immer im DOM, `daily-progress-ring.css` blendet je
 * Breakpoint genau eine per `display:none` aus — kein Doppel-Announce, kein
 * reservierter Platz für die jeweils andere.
 */
export function DailyProgressRing() {
  const tasks = useTasks();
  const habits = useHabits();
  const logs = useHabitLogs();
  const { isActive } = useModules();

  if (tasks === undefined || habits === undefined || logs === undefined) return null;

  const { done, total, open } = computeDailyProgress(tasks, habits, logs, isActive);
  if (total === 0) return null;

  const fraction = done / total;
  const offset = CIRCUMFERENCE * (1 - fraction);

  return (
    <>
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
      <div
        className="daily-progress-ring-wide"
        role="status"
        aria-label={`heute ${done} von ${total} erledigt, ${formatOpen(open)}`}
      >
        <svg
          className="daily-progress-ring-wide__svg"
          viewBox="0 0 72 72"
          width="72"
          height="72"
          aria-hidden="true"
        >
          {total <= MAX_SEGMENTS ? (
            Array.from({ length: total }, (_, i) => (
              <circle
                key={i}
                className={`daily-progress-ring-wide__segment ${
                  i < done
                    ? 'daily-progress-ring-wide__segment--done'
                    : 'daily-progress-ring-wide__segment--open'
                }`}
                cx="36"
                cy="36"
                r={WIDE_RADIUS}
                fill="none"
                pathLength={total}
                strokeDasharray={`${SEGMENT_VISIBLE} ${total - SEGMENT_VISIBLE}`}
                strokeDashoffset={-i}
                transform="rotate(-90 36 36)"
              />
            ))
          ) : (
            <>
              <circle
                className="daily-progress-ring-wide__arc-track"
                cx="36"
                cy="36"
                r={WIDE_RADIUS}
                fill="none"
              />
              <circle
                className="daily-progress-ring-wide__arc"
                cx="36"
                cy="36"
                r={WIDE_RADIUS}
                fill="none"
                strokeDasharray={WIDE_CIRCUMFERENCE}
                strokeDashoffset={WIDE_CIRCUMFERENCE * (1 - fraction)}
                transform="rotate(-90 36 36)"
              />
            </>
          )}
          <text textAnchor="middle">
            <tspan className="daily-progress-ring-wide__count" x="36" y="33">
              {done}
            </tspan>
            <tspan className="daily-progress-ring-wide__of" x="36" y="51">
              von {total}
            </tspan>
          </text>
        </svg>
        <div className="daily-progress-ring-wide__text">
          <div className="daily-progress-ring-wide__label">Heute erledigt</div>
          <div className="daily-progress-ring-wide__breakdown">{formatOpen(open)}</div>
        </div>
      </div>
    </>
  );
}
