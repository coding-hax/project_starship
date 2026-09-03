'use client';

import { historyDays } from './history-days';
import { stepPath } from './step-path';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

/*
 * Geometry in pixels at the 375px screen the card is drawn for: 311 is the
 * card's inner width there (375 − 2×16 page padding − 2×16 card padding), so one
 * user unit is one pixel and the stroke widths in the CSS are literal. `height:
 * auto` there keeps the ratio at every other width — same recipe as
 * weather-day.tsx, and the reason `preserveAspectRatio="none"` is gone: it
 * stretched x by 3.4× and y by only 2×, which turned the end dot into an oval
 * and distorted its outline (issue #1040).
 *
 * The plot stops 18px short of the right edge so the end dot sits fully inside
 * the box. On `cx = VIEW_W` its right half was simply cut off.
 */
const VIEW_W = 311;
const VIEW_H = 88;
/** y of value 0 — with the fixed scale in `stepPath`, a real zero line. */
const BASE_Y = 76;
/** y of "every active routine is on a streak". */
const TOP_Y = 8;
const PLOT_W = 293;
const DOT_R = 4;

/**
 * "Routinen in Serie" as a 30-day step chart (issue #905, redrawn in #1040) —
 * replaces `StreakSummaryCard`, whose current-day count (`countHabitsOnStreak`)
 * lives on in the card head. `historyDays` reruns that same rule once per day, so
 * this card's rightmost value always matches the head number exactly. Renders
 * nothing at 0 active habits, same rule `StreakSummaryCard` already followed
 * (#905 AK7) — a curve of zeroes would say "no streaks" more loudly than silence.
 */
export function HabitHistoryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);
  if (active.length === 0) return null;

  const now = new Date();
  const values = historyDays(habits, logs, now);
  const current = values.at(-1) ?? 0;
  const path = stepPath(values, active.length, PLOT_W, TOP_Y, BASE_Y);
  if (!path) return null;

  const areaD = `${path.d} L${PLOT_W},${BASE_Y} L0,${BASE_Y} Z`;

  return (
    <div className="habit-history-card">
      <div className="habit-history-card__head">
        <p className="habit-history-card__label">Routinen in Serie</p>
        <p className="habit-history-card__value">
          {current}/{active.length}
        </p>
      </div>
      <svg
        className="habit-history-card__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Routinen in Serie, aktuell ${current} von ${active.length}`}
      >
        <defs>
          <linearGradient id="habit-history-area" x1="0" y1="0" x2="0" y2="1">
            <stop className="habit-history-card__area-stop--top" offset="0" />
            <stop className="habit-history-card__area-stop--bottom" offset="1" />
          </linearGradient>
        </defs>
        <line className="habit-history-card__cap" x1="0" y1={TOP_Y} x2={VIEW_W} y2={TOP_Y} />
        <path className="habit-history-card__area" d={areaD} />
        <line className="habit-history-card__baseline" x1="0" y1={BASE_Y} x2={VIEW_W} y2={BASE_Y} />
        <path className="habit-history-card__line" d={path.d} />
        <circle className="habit-history-card__dot" cx={path.endX} cy={path.endY} r={DOT_R} />
      </svg>
      <div className="habit-history-card__axis">
        <span>vor 30 Tagen</span>
        <span>heute</span>
      </div>
    </div>
  );
}
