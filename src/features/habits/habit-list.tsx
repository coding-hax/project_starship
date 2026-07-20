'use client';

import { useState } from 'react';
import { SectionCard } from '@/ui/section-card';
import { Toast } from '@/ui/toast';
import { HabitEditor } from './habit-editor';
import { useArchiveHabit } from './use-archive-habit';
import { useHabits, type HabitView } from './use-habits';

const SCHEDULE_LABELS: Record<HabitView['schedule'], string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  custom: 'Benutzerdefiniert',
};

interface HabitRowProps {
  habit: HabitView;
  onEdit: () => void;
  onToggleArchive: () => void;
}

function HabitRow({ habit, onEdit, onToggleArchive }: HabitRowProps) {
  const archived = habit.archivedAt !== null;

  return (
    <li className="habit-list__item" data-habit-id={habit.id}>
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
    </li>
  );
}

/**
 * The management screen from issue #102 — reachable from "Heute", not its own tab
 * (docs/DESIGN_SYSTEM.md, nav.tsx). Archived habits are hidden from the active list
 * by default and live in their own collapsed section, per the AC.
 */
export function HabitList() {
  const habits = useHabits();
  const { toggleArchive, undo, handleUndo, dismissUndo } = useArchiveHabit();
  const [editingHabitId, setEditingHabitId] = useState<string | null>(null);

  const active = habits?.filter((habit) => habit.archivedAt === null) ?? [];
  const archived = habits?.filter((habit) => habit.archivedAt !== null) ?? [];
  const editingHabit = habits?.find((habit) => habit.id === editingHabitId) ?? null;

  return (
    <>
      {habits === undefined ? null : active.length === 0 && archived.length === 0 ? (
        <p className="habit-list__empty">Keine Gewohnheiten. Leg deine erste an.</p>
      ) : (
        <>
          {active.length === 0 ? (
            <p className="habit-list__empty">Keine aktiven Gewohnheiten.</p>
          ) : (
            <ul className="habit-list" aria-label="Gewohnheiten">
              {active.map((habit) => (
                <HabitRow
                  key={habit.id}
                  habit={habit}
                  onEdit={() => setEditingHabitId(habit.id)}
                  onToggleArchive={() => toggleArchive(habit)}
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
                    onEdit={() => setEditingHabitId(habit.id)}
                    onToggleArchive={() => toggleArchive(habit)}
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
