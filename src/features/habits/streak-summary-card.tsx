'use client';

import { IconHabits } from '@/ui/icons';
import { useBlockReady } from '@/ui/overview-ready';
import { habitsDueToday, toDateKey } from './due-today';
import { historyWeeks } from './history-weeks';
import { periodStatusFor } from './schedule-rules';
import { computeStreak, countHabitsOnStreak, longestEverStreak } from './streak';
import { useHabitLogs, type HabitLogView } from './use-habit-logs';
import { useHabits, type HabitSchedule, type HabitView } from './use-habits';
import { weekGoal } from './week-goal';

const RING_RADIUS_OUTER = 72;
const RING_RADIUS_MIDDLE = 51;
const RING_RADIUS_INNER = 30;
const RING_STROKE = 17;
const RING_SIZE = 176;
const RING_CENTER = RING_SIZE / 2;

function ringCircumference(radius: number): number {
  return 2 * Math.PI * radius;
}

/** `done / total`, clamped to [0, 1] — a 0 denominator reads as an empty ring, never `NaN`. */
function fractionOf(done: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
}

/** The inner ring's unit follows whichever habit is holding the longest current streak. */
const STREAK_UNIT_LABELS: Partial<Record<HabitSchedule, string>> = {
  weekly: 'Wochen',
  biweekly: 'Perioden',
  monthly: 'Monate',
  quarterly: 'Quartale',
  yearly: 'Jahre',
};

function streakUnit(schedule: HabitSchedule): string {
  return schedule === 'daily' || schedule === 'custom' ? 'Tage' : (STREAK_UNIT_LABELS[schedule] ?? 'Perioden');
}

/** "N" (Tage, daily/custom) or "N/M" der laufenden Periode (alle anderen) — die
 *  Unterscheidung, die `habit-today.tsx` schon trifft, hier für die Tabellenspalte
 *  „Serie" wiederverwendet (issue #863). */
function serieCell(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  today: string,
  now: Date,
): string {
  if (habit.schedule === 'daily' || habit.schedule === 'custom') {
    return `${computeStreak(habit, logs, now)}`;
  }
  const status = periodStatusFor(habit, logs, today);
  return `${status.count}/${status.target}`;
}

interface RingSpec {
  key: string;
  radius: number;
  colorVar: string;
  label: string;
  fraction: number;
  value: string;
  denom: string | null;
}

/**
 * Statusblock auf /routinen (issue #863, löst die Ein-Zahl-Karte aus #809 ab):
 * drei konzentrische Ringe (heute / diese Woche / längste Serie), ein Satz,
 * eine Tabelle je Routine — die alte Kennzahl lebt als Tabellenfuß weiter.
 * Rendert nichts während des Ladens und nichts ohne jede aktive Routine —
 * kein Layout-Shift, kein Spinner (siehe `useBlockReady`, wie zuvor).
 *
 * Der innere Ring braucht als Ring einen Nenner (Füllung = Anteil an der
 * längsten je erreichten Serie), die Zahl daneben nicht — sie zeigt nur den
 * rohen Streak-Wert samt Einheit (z. B. "12 Tage"). Die "haltende" Routine
 * ist die mit dem aktuell längsten laufenden Streak über alle aktiven
 * Routinen; ihre eigene `longestEverStreak` ist der Ring-Nenner, ihr
 * `schedule` bestimmt die Einheit.
 */
export function StreakSummaryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  useBlockReady(habits !== undefined && logs !== undefined);

  if (habits === undefined || logs === undefined) return null;

  const activeHabits = habits.filter((habit) => habit.archivedAt === null);
  if (activeHabits.length === 0) return null;

  const now = new Date();
  const today = toDateKey(now);

  const heute = habitsDueToday(habits, logs, now);
  const woche = weekGoal(habits, logs, today);

  const leadingHabit = activeHabits.reduce<{ habit: HabitView; streak: number }>(
    (best, habit) => {
      const streak = computeStreak(habit, logs, now);
      return streak > best.streak ? { habit, streak } : best;
    },
    { habit: activeHabits[0], streak: -1 },
  );
  const longestEver = longestEverStreak(leadingHabit.habit, logs, now);
  const onStreakCount = countHabitsOnStreak(habits, logs, now);

  const rings: RingSpec[] = [
    {
      key: 'heute',
      radius: RING_RADIUS_OUTER,
      colorVar: '--swatch-amber',
      label: 'Heute',
      fraction: fractionOf(heute.done, heute.due),
      value: `${heute.done}`,
      denom: `/ ${heute.due}`,
    },
    {
      key: 'woche',
      radius: RING_RADIUS_MIDDLE,
      colorVar: '--swatch-sky',
      label: 'Diese Woche',
      fraction: fractionOf(woche.done, woche.goal),
      value: `${woche.done}`,
      denom: `/ ${woche.goal}`,
    },
    {
      key: 'serie',
      radius: RING_RADIUS_INNER,
      colorVar: '--area-habits',
      label: 'Längste Serie',
      fraction: fractionOf(leadingHabit.streak, longestEver),
      value: `${leadingHabit.streak} ${streakUnit(leadingHabit.habit.schedule)}`,
      denom: null,
    },
  ];

  return (
    <div className="streak-summary-card">
      <div className="streak-summary-card__rings">
        <svg
          className="streak-summary-card__svg"
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          width={RING_SIZE}
          height={RING_SIZE}
          aria-hidden="true"
        >
          {rings.map((ring) => {
            const circumference = ringCircumference(ring.radius);
            return (
              <g key={ring.key}>
                <circle
                  className="streak-summary-card__ring-track"
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={ring.radius}
                  fill="none"
                  strokeWidth={RING_STROKE}
                />
                <circle
                  className="streak-summary-card__ring-fill"
                  data-ring={ring.key}
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={ring.radius}
                  fill="none"
                  strokeWidth={RING_STROKE}
                  strokeLinecap="round"
                  style={{ stroke: `var(${ring.colorVar})` }}
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - ring.fraction)}
                  transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                />
              </g>
            );
          })}
        </svg>
        <ul className="streak-summary-card__legend">
          {rings.map((ring) => (
            <li key={ring.key} data-ring={ring.key} className="streak-summary-card__legend-item">
              <span
                className="streak-summary-card__legend-label"
                style={{ color: `var(${ring.colorVar})` }}
              >
                {ring.label}
              </span>
              <span className="streak-summary-card__legend-value">
                {ring.value}
                {ring.denom !== null && (
                  <span className="streak-summary-card__legend-denom"> {ring.denom}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="streak-summary-card__sentence">
        <span className="streak-summary-card__sentence-strong">
          {heute.done} von {heute.due}
        </span>{' '}
        heute.{' '}
        <span className="streak-summary-card__sentence-strong">
          {onStreakCount} von {activeHabits.length}
        </span>{' '}
        Routinen laufen gerade{' '}
        <span className="streak-summary-card__sentence-strong">in Serie</span>.
      </p>

      <table className="streak-summary-card__table">
        <colgroup>
          <col />
          <col style={{ width: '76px' }} />
          <col style={{ width: '48px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Routine</th>
            <th scope="col">12 Wochen</th>
            <th scope="col">Serie</th>
          </tr>
        </thead>
        <tbody>
          {activeHabits.map((habit) => (
            <tr key={habit.id}>
              <td className="streak-summary-card__habit-name">{habit.name}</td>
              <td>
                <div className="streak-summary-card__bars" aria-hidden="true">
                  {historyWeeks(habit, logs, today).map((bar, index) => (
                    <span
                      key={index}
                      className="streak-summary-card__bar"
                      style={{
                        height: `${Math.round(bar.ratio * 100)}%`,
                        background: `var(${habit.color ?? '--area-habits'})`,
                        opacity: bar.isCurrent ? 1 : 0.34,
                      }}
                    />
                  ))}
                </div>
              </td>
              <td className="streak-summary-card__serie">{serieCell(habit, logs, today, now)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="streak-summary-card__footer">
              Routinen in Serie — {onStreakCount} von {activeHabits.length} aktiv
              <IconHabits className="streak-summary-card__footer-icon" />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
