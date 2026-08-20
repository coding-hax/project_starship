'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { HabitToday } from './habit-today';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `routinen` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. Heading row via `OverviewBlock` (issue #652).
 * `StreakSummaryCard` (issue #431, umgebaut in #809) moved to /routinen in
 * the same ticket — the busy daily overview keeps only today's check-off list.
 */
export function HabitsOverviewSection() {
  return (
    <OverviewBlock title="Routinen" area="var(--area-habits)">
      <HabitToday />
    </OverviewBlock>
  );
}
