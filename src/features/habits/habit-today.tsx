'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { mutate } from '@/local/outbox';
import { Toast } from '@/ui/toast';
import { doneEarlierThisWeek, toDateKey } from './due-today';
import { canRescue, currentStreakUsesFreeze, gapDay } from './freeze';
import { computeStreak } from './streak';
import { useHabitFreezes } from './use-habit-freezes';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

const RESCUE_UNDO_TIMEOUT_MS = 5000;

interface RescueUndo {
  freezeId: string;
  habitName: string;
}

/**
 * The daily check-off list (issue #103), on /uebersicht next to the shortcut into the
 * management screen (issue #102) — the /gewohnheiten tab (issue #123) is the
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
  const freezes = useHabitFreezes();
  const toggle = useToggleHabitLog(logs);

  const [rescueUndo, setRescueUndo] = useState<RescueUndo | null>(null);
  const rescueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissRescueUndo = useCallback(() => {
    if (rescueTimeoutRef.current !== null) {
      clearTimeout(rescueTimeoutRef.current);
      rescueTimeoutRef.current = null;
    }
    setRescueUndo(null);
  }, []);

  const rescueStreak = useCallback(
    async (habitId: string, habitName: string, now: Date) => {
      const freezeId = await mutate({
        table: 'habit_freezes',
        op: 'upsert',
        payload: { habitId, freezeDate: gapDay(now) },
      });
      dismissRescueUndo();
      setRescueUndo({ freezeId, habitName });
      rescueTimeoutRef.current = setTimeout(dismissRescueUndo, RESCUE_UNDO_TIMEOUT_MS);
    },
    [dismissRescueUndo],
  );

  const handleRescueUndo = useCallback(async () => {
    if (!rescueUndo) return;
    const { freezeId } = rescueUndo;
    dismissRescueUndo();
    await mutate({ table: 'habit_freezes', rowId: freezeId, op: 'delete' });
  }, [rescueUndo, dismissRescueUndo]);

  if (habits === undefined || logs === undefined || freezes === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);

  if (active.length === 0) {
    return (
      <p className="habit-today__empty">
        Noch keine Gewohnheiten.{' '}
        <Link href="/gewohnheiten">Jetzt anlegen</Link>
      </p>
    );
  }

  const now = new Date();
  const today = toDateKey(now);

  return (
    <>
      <ul className="habit-today" aria-label="Gewohnheiten heute">
        {active.map((habit) => {
          const doneToday = logs.some(
            (log) => log.habitId === habit.id && log.logDate === today && log.done,
          );
          const showWeekHint = doneEarlierThisWeek(habit, logs, now);
          const streak = computeStreak(habit, logs, freezes, now);
          const usesFreeze = currentStreakUsesFreeze(habit, logs, freezes, now);
          const rescuable = canRescue(habit, logs, freezes, now);
          return (
            <li
              key={habit.id}
              className={
                doneToday ? 'habit-today__item habit-today__item--done' : 'habit-today__item'
              }
            >
              <span
                className="habit-today__color"
                style={{ background: `var(${habit.color ?? '--area-habits'})` }}
                aria-hidden="true"
              />
              <span className="habit-today__name-group">
                <span className="habit-today__name">{habit.name}</span>
                {showWeekHint && (
                  <span className="habit-today__week-hint">Diese Woche schon erledigt</span>
                )}
                {rescuable && (
                  <button
                    type="button"
                    className="habit-today__rescue"
                    onClick={() => rescueStreak(habit.id, habit.name, now)}
                  >
                    Serie mit Joker retten
                  </button>
                )}
              </span>
              {streak > 0 && (
                <span
                  className="habit-today__streak"
                  style={{ color: `var(${habit.color ?? '--area-habits'})` }}
                  aria-label={`Streak: ${streak}${usesFreeze ? ', mit Joker überbrückt' : ''}`}
                >
                  <span aria-hidden="true">🔥</span> {streak}
                  {usesFreeze && <span aria-hidden="true"> ❄️</span>}
                </span>
              )}
              <span className="habit-today__checkbox-wrap">
                <input
                  type="checkbox"
                  className="habit-today__checkbox"
                  checked={doneToday}
                  onChange={() => toggle(habit.id, today)}
                  aria-label={`${habit.name} für heute abhaken`}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {rescueUndo && (
        <Toast
          message={`Serie von „${rescueUndo.habitName}" mit Joker gerettet`}
          actionLabel="Rückgängig"
          onAction={handleRescueUndo}
          onDismiss={dismissRescueUndo}
        />
      )}
    </>
  );
}
