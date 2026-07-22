'use client';

import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SectionCard } from '@/ui/section-card';
import { Toast } from '@/ui/toast';
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
  custom: 'Benutzerdefiniert',
};

interface HabitRowProps {
  habit: HabitView;
  logs: HabitLogView[];
  viewedMonth: Date;
  onEdit: () => void;
  onToggleArchive: () => void;
  onToggleLog: (habitId: string, logDate: string) => void;
}

function HabitRow({
  habit,
  logs,
  viewedMonth,
  onEdit,
  onToggleArchive,
  onToggleLog,
}: HabitRowProps) {
  const archived = habit.archivedAt !== null;

  return (
    <li className="habit-list__item" data-habit-id={habit.id}>
      <div className="habit-list__row">
        <span
          className="habit-list__color"
          style={{ background: `var(${habit.color ?? '--area-habits'})` }}
          aria-hidden="true"
        />
        <button type="button" className="habit-list__name" onClick={onEdit}>
          <span className="habit-list__title">{habit.name}</span>
          <span className="habit-list__schedule">{SCHEDULE_LABELS[habit.schedule]}</span>
        </button>
        <button type="button" className="habit-list__archive" onClick={onToggleArchive}>
          {archived ? 'Reaktivieren' : 'Archivieren'}
        </button>
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
 * The management screen from issue #102 — reachable from "Heute", not its own tab
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

  const active = habits?.filter((habit) => habit.archivedAt === null) ?? [];
  const archived = habits?.filter((habit) => habit.archivedAt !== null) ?? [];
  const editingHabit = habits?.find((habit) => habit.id === editingHabitId) ?? null;
  const visibleLogs = logs ?? [];

  return (
    <>
      {habits === undefined ? null : active.length === 0 && archived.length === 0 ? (
        <p className="habit-list__empty">Keine Gewohnheiten. Leg deine erste an.</p>
      ) : (
        <>
          <MonthNav viewedMonth={viewedMonth} onChange={setViewedMonth} />

          {active.length === 0 ? (
            <p className="habit-list__empty">Keine aktiven Gewohnheiten.</p>
          ) : (
            <ul className="habit-list" aria-label="Gewohnheiten">
              {active.map((habit) => (
                <HabitRow
                  key={habit.id}
                  habit={habit}
                  logs={visibleLogs}
                  viewedMonth={viewedMonth}
                  onEdit={() => setEditingHabitId(habit.id)}
                  onToggleArchive={() => toggleArchive(habit)}
                  onToggleLog={toggleLog}
                />
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <SectionCard title="Archiviert" collapsible defaultOpen={false}>
              <ul className="habit-list" aria-label="Archivierte Gewohnheiten">
                {archived.map((habit) => (
                  <HabitRow
                    key={habit.id}
                    habit={habit}
                    logs={visibleLogs}
                    viewedMonth={viewedMonth}
                    onEdit={() => setEditingHabitId(habit.id)}
                    onToggleArchive={() => toggleArchive(habit)}
                    onToggleLog={toggleLog}
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
