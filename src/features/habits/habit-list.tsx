'use client';

import { useMemo, useState } from 'react';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SectionCard } from '@/ui/section-card';
import { Toast } from '@/ui/toast';
import { useListPresence } from '@/ui/use-list-presence';
import { addMonths, monthLabel, startOfMonth } from './due-today';
import { HabitEditor } from './habit-editor';
import { HabitWeekGrid } from './habit-week-grid';
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

interface HabitRowProps {
  habit: HabitView;
  logs: HabitLogView[];
  viewedMonth: Date;
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
  viewedMonth,
  onEdit,
  onToggleArchive,
  onToggleLog,
  entering,
  leaving,
  onAnimationEnd,
}: HabitRowProps) {
  const archived = habit.archivedAt !== null;

  return (
    <li
      className="habit-list__item list-motion-item"
      data-habit-id={habit.id}
      data-entering={entering}
      data-leaving={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="habit-list__row">
        <span
          className="habit-list__color"
          style={{ background: `var(${habit.color ?? '--area-habits'})` }}
          aria-hidden="true"
        />
        <button type="button" className="habit-list__name" onClick={onEdit}>
          <span className="habit-list__title">{habit.name}</span>
          <span className="habit-list__schedule">{scheduleLabel(habit)}</span>
        </button>
        {habit.id !== JOURNAL_HABIT_ID && (
          <button type="button" className="habit-list__archive" onClick={onToggleArchive}>
            {archived ? 'Reaktivieren' : 'Archivieren'}
          </button>
        )}
      </div>
      <HabitWeekGrid habit={habit} logs={logs} onToggle={onToggleLog} viewedMonth={viewedMonth} />
    </li>
  );
}

interface MonthNavProps {
  viewedMonth: Date;
  onChange: (month: Date) => void;
}

/** Month bar above the list — one control for all habit grids at once (issue #124 AC2). */
function MonthNav({ viewedMonth, onChange }: MonthNavProps) {
  return (
    <div className="habit-list__month-nav">
      <button
        type="button"
        className="habit-list__month-nav-button"
        aria-label="Vorheriger Monat"
        onClick={() => onChange(addMonths(viewedMonth, -1))}
      >
        <IconChevronLeft />
      </button>
      <span className="habit-list__month-nav-label">{monthLabel(viewedMonth)}</span>
      <button
        type="button"
        className="habit-list__month-nav-button"
        aria-label="Nächster Monat"
        onClick={() => onChange(addMonths(viewedMonth, 1))}
      >
        <IconChevronRight />
      </button>
    </div>
  );
}

/**
 * The management screen from issue #102 — reachable from "Übersicht", not its own tab
 * (docs/DESIGN_SYSTEM.md, nav.tsx). Archived habits are hidden from the active list
 * by default and live in their own collapsed section, per the AC.
 */
export function HabitList() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleLog = useToggleHabitLog(logs);
  const { toggleArchive, undo, handleUndo, dismissUndo } = useArchiveHabit();
  const [editingHabitId, setEditingHabitId] = useState<string | null>(null);
  const [viewedMonth, setViewedMonth] = useState<Date>(() => startOfMonth(new Date()));

  // `useMemo`'d on `habits` alone (referentially stable across renders that
  // aren't a real live-query emission, see use-live-table.ts) — `useListPresence`
  // reads a fresh array/object identity as "changed", so an unmemoized filter()
  // here would re-diff (and re-render) on every unrelated re-render.
  const active = useMemo(() => habits?.filter((habit) => habit.archivedAt === null) ?? [], [habits]);
  const archived = useMemo(
    () => habits?.filter((habit) => habit.archivedAt !== null) ?? [],
    [habits],
  );
  const activeRows = useListPresence(active, (habit) => habit.id);
  const archivedRows = useListPresence(archived, (habit) => habit.id);
  const editingHabit = habits?.find((habit) => habit.id === editingHabitId) ?? null;
  const visibleLogs = logs ?? [];

  return (
    <>
      {habits === undefined ? null : active.length === 0 && archived.length === 0 ? (
        <p className="habit-list__empty">Keine Routinen. Leg deine erste an.</p>
      ) : (
        <>
          <MonthNav viewedMonth={viewedMonth} onChange={setViewedMonth} />

          {activeRows.length === 0 ? (
            <p className="habit-list__empty">Keine aktiven Routinen.</p>
          ) : (
            <ul className="habit-list" aria-label="Routinen">
              {activeRows.map((row) => (
                <HabitRow
                  key={row.key}
                  habit={row.item}
                  logs={visibleLogs}
                  viewedMonth={viewedMonth}
                  onEdit={() => setEditingHabitId(row.item.id)}
                  onToggleArchive={() => toggleArchive(row.item)}
                  onToggleLog={toggleLog}
                  entering={row.status === 'entering'}
                  leaving={row.status === 'leaving'}
                  onAnimationEnd={row.onAnimationEnd}
                />
              ))}
            </ul>
          )}

          {archivedRows.length > 0 && (
            <SectionCard title="Archiviert" collapsible defaultOpen={false}>
              <ul className="habit-list" aria-label="Archivierte Routinen">
                {archivedRows.map((row) => (
                  <HabitRow
                    key={row.key}
                    habit={row.item}
                    logs={visibleLogs}
                    viewedMonth={viewedMonth}
                    onEdit={() => setEditingHabitId(row.item.id)}
                    onToggleArchive={() => toggleArchive(row.item)}
                    onToggleLog={toggleLog}
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

      {undo && (
        <Toast
          message={`„${undo.name}" archiviert`}
          actionLabel="Rückgängig"
          onAction={handleUndo}
          onDismiss={dismissUndo}
        />
      )}
    </>
  );
}
