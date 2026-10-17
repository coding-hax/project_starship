'use client';

import { useId, useMemo, useState } from 'react';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { startOfMonth, toDateKey } from './due-today';
import { HabitWeekGrid } from './habit-week-grid';
import { historyWeeks } from './history-weeks';
import { monthProgress } from './month-progress';
import { RowMonthNav } from './row-month-nav';
import { periodStatusFor } from './schedule-rules';
import { computeStreak } from './streak';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const SCHEDULE_LABELS: Record<HabitView['schedule'], string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  biweekly: 'Alle zwei Wochen',
  monthly: 'Monatlich',
  quarterly: 'Quartalsweise',
  yearly: 'Jährlich',
  custom: 'Benutzerdefiniert',
};

function scheduleLabel(habit: HabitView): string {
  const base = SCHEDULE_LABELS[habit.schedule];
  return habit.schedule === 'weekly' && habit.target > 1 ? `${habit.target}× pro Woche` : base;
}

function isDayBased(schedule: HabitView['schedule']): boolean {
  return schedule === 'daily' || schedule === 'custom';
}

export interface HabitRowProps {
  habit: HabitView;
  logs: HabitLogView[];
  now: Date;
  onEdit: () => void;
  onToggleArchive: () => void;
  onToggleLog: (habitId: string, logDate: string) => void;
  entering: boolean;
  leaving: boolean;
  onAnimationEnd: () => void;
}

/**
 * One collapsed row — shared by the active table (`habit-table.tsx`) and the
 * archived section (`habit-archive-card.tsx`, issue #1196): same row shape,
 * same editor hand-off, same expand/collapse behaviour either way.
 */
export function HabitRow({
  habit,
  logs,
  now,
  onEdit,
  onToggleArchive,
  onToggleLog,
  entering,
  leaving,
  onAnimationEnd,
}: HabitRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [viewedMonth, setViewedMonth] = useState<Date>(() => startOfMonth(now));
  const contentId = useId();
  const archived = habit.archivedAt !== null;

  const weeks = useMemo(() => historyWeeks(habit, logs, now), [habit, logs, now]);
  const serieLabel = isDayBased(habit.schedule)
    ? String(computeStreak(habit, logs, now))
    : (() => {
        const status = periodStatusFor(habit, logs, toDateKey(now));
        return `${status.count}/${status.target}`;
      })();
  const { done, due } = monthProgress(habit, logs, viewedMonth);

  return (
    <li
      className="habit-table__row list-motion-item"
      data-habit-id={habit.id}
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      <button
        type="button"
        className="habit-table__row-header"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        {habit.emoji ? (
          <span className="habit-table__emoji" aria-hidden="true">
            {habit.emoji}
          </span>
        ) : (
          <span className="habit-table__color" aria-hidden="true" />
        )}
        <span className="habit-table__title">
          <span className="habit-table__name">{habit.name}</span>
          <span className="habit-table__schedule">{scheduleLabel(habit)}</span>
        </span>
        <span className="habit-table__weeks" aria-hidden="true">
          {weeks.map((week, index) => (
            <span
              key={index}
              className="habit-table__week-bar"
              data-current={index === weeks.length - 1 ? '' : undefined}
              style={{
                height: `${week.due > 0 ? Math.max(0.08, Math.min(1, week.done / week.due)) * 100 : 8}%`,
              }}
            />
          ))}
        </span>
        <span className="habit-table__streak">{serieLabel}</span>
        <span className="habit-table__chevron" data-open={expanded} aria-hidden="true" />
      </button>
      <div className="habit-table__collapse" data-open={expanded}>
        <div className="habit-table__body" id={contentId} inert={!expanded}>
          <div className="habit-table__body-inner">
            <RowMonthNav viewedMonth={viewedMonth} onChange={setViewedMonth} />
            <HabitWeekGrid habit={habit} logs={logs} onToggle={onToggleLog} viewedMonth={viewedMonth} now={now} />
            <p className="habit-table__progress">
              {done} von {due} fälligen Tagen erledigt
            </p>
            <div className="habit-table__actions">
              <button type="button" className="habit-table__action" onClick={onEdit}>
                Bearbeiten
              </button>
              {habit.id !== JOURNAL_HABIT_ID && (
                <button type="button" className="habit-table__action" onClick={onToggleArchive}>
                  {archived ? 'Reaktivieren' : 'Archivieren'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
