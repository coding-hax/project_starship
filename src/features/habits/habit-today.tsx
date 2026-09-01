'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { IconStreak } from '@/ui/icons';
import { useBlockReady } from '@/ui/overview-ready';
import { metEarlierInPeriod, toDateKey } from './due-today';
import { periodStatusFor } from './schedule-rules';
import { computeStreak } from './streak';
import { useHabitLogs } from './use-habit-logs';
import { useHabits, type HabitSchedule } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

/** "<Hinweis> schon erledigt" per Periode (issue #509, weekly ist #224's Wortlaut). */
const PERIOD_DONE_HINTS: Partial<Record<HabitSchedule, string>> = {
  weekly: 'Diese Woche schon erledigt',
  biweekly: 'Diese zwei Wochen schon erledigt',
  monthly: 'Diesen Monat schon erledigt',
  quarterly: 'Dieses Quartal schon erledigt',
  yearly: 'Dieses Jahr schon erledigt',
};

/** "N von M <Periode>" — der Perioden-Teil für den offenen Zwischenstand (AC2). */
const PERIOD_PROGRESS_LABELS: Partial<Record<HabitSchedule, string>> = {
  weekly: 'diese Woche',
  biweekly: 'in diesen zwei Wochen',
  monthly: 'diesen Monat',
  quarterly: 'dieses Quartal',
  yearly: 'dieses Jahr',
};

/**
 * The daily check-off list (issue #103), on /uebersicht next to the shortcut into the
 * management screen (issue #102) — the /routinen tab (issue #123) is the
 * other entry point.
 *
 * Unlike the task list, a checked-off row stays in place rather than
 * disappearing: the tap that checked it is also how you undo it (AC2), so the
 * row has to stay reachable. Weekly habits never drop out of this list either
 * (issue #224) — one already checked off earlier this week carries a
 * "Diese Woche schon erledigt" hint regardless of today's own checkbox state
 * (issue #288): it says something about the week, not about today.
 */
export function HabitToday() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggle = useToggleHabitLog(logs);

  useBlockReady(habits !== undefined && logs !== undefined);

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);

  if (active.length === 0) {
    return (
      <p className="habit-today__empty">
        Noch keine Routinen.{' '}
        <Link href="/routinen">Jetzt anlegen</Link>
      </p>
    );
  }

  const now = new Date();
  const today = toDateKey(now);

  return (
    <ul className="habit-today" aria-label="Routinen heute">
      {active.map((habit) => {
        const doneToday = logs.some(
          (log) => log.habitId === habit.id && log.logDate === today && log.done,
        );
        const doneHint = PERIOD_DONE_HINTS[habit.schedule];
        const showWeekHint = doneHint !== undefined && metEarlierInPeriod(habit, logs, now);
        const progressLabel = PERIOD_PROGRESS_LABELS[habit.schedule];
        const status = progressLabel !== undefined ? periodStatusFor(habit, logs, today) : null;
        const showProgress = status !== null && !showWeekHint && status.target > 1 && !status.met;
        const streak = computeStreak(habit, logs, now);
        const isJournal = habit.id === JOURNAL_HABIT_ID;
        const toneVar = `var(${habit.color ?? '--area-habits'})`;
        return (
          <li
            key={habit.id}
            className={
              doneToday ? 'habit-today__item habit-today__item--done' : 'habit-today__item'
            }
          >
            <span className="habit-today__lead">
              {streak > 0 ? (
                <span
                  className="habit-today__streak"
                  style={{ '--habit-tone': toneVar } as CSSProperties}
                  aria-label={`Streak: ${streak}`}
                >
                  <IconStreak className="habit-today__streak-icon" /> {streak}
                </span>
              ) : (
                <span
                  className="habit-today__color"
                  style={{ background: toneVar }}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="habit-today__name-group">
              <span className="habit-today__name">{habit.name}</span>
              {showWeekHint && <span className="habit-today__week-hint">{doneHint}</span>}
              {showProgress && status && (
                <span className="habit-today__week-hint">
                  {status.count} von {status.target} {progressLabel}
                </span>
              )}
            </span>
            <label className="habit-today__checkbox-wrap">
              <input
                type="checkbox"
                className="habit-today__checkbox"
                checked={doneToday}
                disabled={isJournal}
                onChange={isJournal ? undefined : () => toggle(habit.id, today)}
                aria-label={
                  isJournal
                    ? `${habit.name}${doneToday ? ' heute geschrieben' : ' heute noch nicht geschrieben'}`
                    : `${habit.name} für heute abhaken`
                }
              />
            </label>
          </li>
        );
      })}
    </ul>
  );
}
