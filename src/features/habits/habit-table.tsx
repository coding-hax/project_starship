'use client';

import { useMemo, useState } from 'react';
import { OfflineNotice } from '@/ui/offline-notice';
import { useListPresence } from '@/ui/use-list-presence';
import { useOnline } from '@/ui/use-online';
import { HabitEditor } from './habit-editor';
import { HabitRow } from './habit-row';
import { useArchiveHabit } from './use-archive-habit';
import { useHabitLogs } from './use-habit-logs';
import { useHabits, type HabitView } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

/**
 * The table from issue #905 (T3), replacing `HabitList`: one `--surface`
 * card, one collapsed row per active habit — the management screen from
 * issue #102 lives inside the expanded row now instead of being its own
 * always-open block. Archived habits moved into their own sibling
 * component, `habit-archive-card.tsx` (issue #1196) — this component only
 * ever renders the active list (or the matching empty state) now.
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
  const archivedCount = useMemo(
    () => habits?.filter((habit) => habit.archivedAt !== null).length ?? 0,
    [habits],
  );
  const activeRows = useListPresence(active, (habit) => habit.id);
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
      {active.length === 0 && archivedCount === 0 ? (
        <p className="habit-table__empty">Keine Routinen. Leg deine erste an.</p>
      ) : activeRows.length === 0 ? (
        <p className="habit-table__empty">Keine aktiven Routinen.</p>
      ) : (
        <div className="habit-table">
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

      <HabitEditor
        open={editingHabitId !== null}
        mode="edit"
        habit={editingHabit}
        onClose={() => setEditingHabitId(null)}
      />
    </>
  );
}
