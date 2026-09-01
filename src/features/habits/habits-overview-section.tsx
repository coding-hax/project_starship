'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { HabitToday } from './habit-today';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `routinen` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. `HabitToday` renders its own card head, empty state
 * and rows inside one shared surface (issue #995) — this wrapper stays thin,
 * same shape as `TasksOverviewSection`. `StreakSummaryCard` (issue #431,
 * umgebaut in #809) moved to /routinen in the same ticket — the busy daily
 * overview keeps only today's check-off list.
 */
export function HabitsOverviewSection() {
  return (
    <OverviewBlock>
      <HabitToday />
    </OverviewBlock>
  );
}
