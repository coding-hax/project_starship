'use client';

import { OverviewBlock, OverviewCardHead } from '@/ui/overview-block';
import { useBlockReady } from '@/ui/overview-ready';
import { computeHabitProgress } from './habit-progress';
import { HabitToday } from './habit-today';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `routinen` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. Own card head "Routinen" → "N von M" (issue #972,
 * AK2/AK4), `computeHabitProgress` shared with the progress ring
 * (`daily-progress.ts`) so the two numbers never drift apart. `total === 0`
 * (no habit due) drops the count/link, same as the ring showing nothing. Its
 * own `useBlockReady` call joins `HabitToday`'s in the shared reveal point
 * (issue #642) — both read the same tables, but only gating on both makes it
 * certain the count is never the one thing to pop in after reveal (AK5).
 * `StreakSummaryCard` (issue #431, umgebaut in #809) moved to /routinen in the
 * same ticket — the busy daily overview keeps only today's check-off list.
 */
export function HabitsOverviewSection() {
  const habits = useHabits();
  const logs = useHabitLogs();
  useBlockReady(habits !== undefined && logs !== undefined);
  const progress = habits !== undefined && logs !== undefined ? computeHabitProgress(habits, logs) : undefined;

  return (
    <OverviewBlock>
      <section className="overview-block__head-card">
        <OverviewCardHead
          title="Routinen"
          href="/routinen"
          moreLabel={progress && progress.total > 0 ? `${progress.done} von ${progress.total}` : undefined}
        />
      </section>
      <HabitToday />
    </OverviewBlock>
  );
}
