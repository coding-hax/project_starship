'use client';

import type { CSSProperties } from 'react';
import { useId, useMemo, useState } from 'react';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { OfflineNotice } from '@/ui/offline-notice';
import { SectionCard } from '@/ui/section-card';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { startOfMonth, toDateKey } from './due-today';
import { HabitEditor } from './habit-editor';
import { HabitWeekGrid } from './habit-week-grid';
import { historyWeeks } from './history-weeks';
import { monthProgress } from './month-progress';
import { RowMonthNav } from './row-month-nav';
import { periodStatusFor } from './schedule-rules';
import { computeStreak } from './streak';
import { useArchiveHabit } from './use-archive-habit';
import { useHabitLogs, type HabitLogView } from './use-habit-logs';
import { useHabits, type HabitView } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

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

interface HabitRowProps {
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

function HabitRow({
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
  const colorVar = `var(${habit.color ?? '--area-habits'})`;

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
        <span className="habit-table__color" style={{ background: colorVar }} aria-hidden="true" />
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
              style={
                {
                  height: `${week.due > 0 ? Math.max(0.08, Math.min(1, week.done / week.due)) * 100 : 8}%`,
                  '--week-bar-color': colorVar,
                } as CSSProperties
              }
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

/**
 * The table from issue #905 (T3), replacing `HabitList`: one `--surface`
 * card, one collapsed row per active habit — the management screen from
 * issue #102 lives inside the expanded row now instead of being its own
 * always-open block. Archived habits keep their own collapsed section below,
 * unchanged from `HabitList` (issue #486).
 */
export function HabitTable() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleLog = useToggleHabitLog(logs);
  const { toggleArchive } = useArchiveHabit();
  const [editingHabitId, setEditingHabitId] = useState<string | null>(null);
  const online = useOnline();
  const now = new Date();

  // See habit-list.tsx's identical comment: memoized so `useListPresence`
  // only re-diffs on a real live-query emission, not every unrelated render.
  const active = useMemo(() => habits?.filter((habit) => habit.archivedAt === null) ?? [], [habits]);
  const archived = useMemo(
    () => habits?.filter((habit) => habit.archivedAt !== null) ?? [],
    [habits],
  );
  const activeRows = useListPresence(active, (habit) => habit.id);
  const archivedRows = useListPresence(archived, (habit) => habit.id);
  const editingHabit = habits?.find((habit) => habit.id === editingHabitId) ?? null;
  const visibleLogs = logs ?? [];

  if (habits === undefined) return null;

  const rowProps = (habit: HabitView) => ({
    habit,
    logs: visibleLogs,
    now,
    onEdit: () => setEditingHabitId(habit.id),
    onToggleArchive: () => toggleArchive(habit),
    onToggleLog: toggleLog,
  });

  return (
    <>
      {!online && (
        <OfflineNotice>
          Offline — deine Häkchen liegen lokal und werden synchronisiert, sobald du wieder online
          bist.
        </OfflineNotice>
      )}
      {active.length === 0 && archived.length === 0 ? (
        <p className="habit-table__empty">Keine Routinen. Leg deine erste an.</p>
      ) : (
        <>
          {activeRows.length === 0 ? (
            <p className="habit-table__empty">Keine aktiven Routinen.</p>
          ) : (
            <div className="habit-table">
              <p className="habit-table__head" aria-hidden="true">
                Routine · 12 Wochen · Serie
              </p>
              <ul className="habit-table__rows" aria-label="Routinen">
                {activeRows.map((row) => (
                  <HabitRow
                    key={row.key}
                    {...rowProps(row.item)}
                    entering={row.status === 'entering'}
                    leaving={row.status === 'leaving'}
                    onAnimationEnd={row.onAnimationEnd}
                  />
                ))}
              </ul>
            </div>
          )}

          {archivedRows.length > 0 && (
            <SectionCard title="Archiviert" collapsible defaultOpen={false}>
              <ul className="habit-table__rows" aria-label="Archivierte Routinen">
                {archivedRows.map((row) => (
                  <HabitRow
                    key={row.key}
                    {...rowProps(row.item)}
                    entering={row.status === 'entering'}
                    leaving={row.status === 'leaving'}
                    onAnimationEnd={row.onAnimationEnd}
                  />
                ))}
              </ul>
            </SectionCard>
          )}
        </>
      )}

      <HabitEditor
        open={editingHabitId !== null}
        mode="edit"
        habit={editingHabit}
        onClose={() => setEditingHabitId(null)}
      />
    </>
  );
}
