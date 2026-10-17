'use client';

import { useMemo, useState } from 'react';
import { SectionCard } from '@/ui/section-card';
import { useListPresence } from '@/ui/use-list-presence';
import { HabitEditor } from './habit-editor';
import { HabitRow } from './habit-row';
import { useArchiveHabit } from './use-archive-habit';
import { useHabitLogs } from './use-habit-logs';
import { useHabits, type HabitView } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

/**
 * The collapsed "Archiviert" section, split out of `habit-table.tsx` (issue
 * #1196) so it can stand below `HabitHistoryCard` in `page.tsx` instead of
 * directly behind the active table. Own live-queries rather than props from
 * `HabitTable` — cheap in Dexie, and it keeps both components independent of
 * each other's render. Renders nothing while there are no archived habits,
 * same rule the inline section followed before the split.
 */
export function HabitArchiveCard() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggleLog = useToggleHabitLog(logs);
  const { toggleArchive } = useArchiveHabit();
  const [editingHabitId, setEditingHabitId] = useState<string | null>(null);
  const now = new Date();

  const archived = useMemo(
    () => habits?.filter((habit) => habit.archivedAt !== null) ?? [],
    [habits],
  );
  const archivedRows = useListPresence(archived, (habit) => habit.id);
  const editingHabit = habits?.find((habit) => habit.id === editingHabitId) ?? null;
  const visibleLogs = logs ?? [];

  if (archivedRows.length === 0) return null;

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
      <SectionCard className="habit-archive-card" title="Archiviert" collapsible defaultOpen={false}>
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

      <HabitEditor
        open={editingHabitId !== null}
        mode="edit"
        habit={editingHabit}
        onClose={() => setEditingHabitId(null)}
      />
    </>
  );
}
