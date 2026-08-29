'use client';

import { buildLinePath } from '@/features/activities/line-path';
import { historyDays } from './history-days';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

const WIDTH = 100;
const HEIGHT = 32;

function valueToY(value: number, min: number, max: number): number {
  const range = max - min;
  return range === 0 ? HEIGHT / 2 : HEIGHT - ((value - min) / range) * HEIGHT;
}

/**
 * "Routinen in Serie" as a 30-day area chart (issue #905) — replaces
 * `StreakSummaryCard`, whose current-day count (`countHabitsOnStreak`) lives
 * on in the card head. `historyDays` reruns that same rule once per day, so
 * this card's rightmost value always matches the head number exactly. Renders
 * nothing at 0 active habits, same rule `StreakSummaryCard` already followed
 * (AK7) — a curve of zeroes would say "no streaks" more loudly than silence.
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
  const line = buildLinePath(values, WIDTH, HEIGHT);
  if (!line) return null;

  const areaD = `${line.d} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;
  const endY = valueToY(current, line.min, line.max);

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
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Routinen in Serie, aktuell ${current} von ${active.length}`}
      >
        <line
          className="habit-history-card__gridline"
          x1="0"
          y1={HEIGHT / 2}
          x2={WIDTH}
          y2={HEIGHT / 2}
          vectorEffect="non-scaling-stroke"
        />
        <line
          className="habit-history-card__baseline"
          x1="0"
          y1={HEIGHT}
          x2={WIDTH}
          y2={HEIGHT}
          vectorEffect="non-scaling-stroke"
        />
        <path className="habit-history-card__area" d={areaD} stroke="none" />
        <path
          className="habit-history-card__line"
          d={line.d}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <circle className="habit-history-card__dot" cx={WIDTH} cy={endY} r="2" />
      </svg>
      <div className="habit-history-card__axis">
        <span>vor 30 Tagen</span>
        <span>heute</span>
      </div>
    </div>
  );
}
