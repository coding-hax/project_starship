'use client';

import { HabitToday } from './habit-today';
import { WeeklyRecapCard } from './weekly-recap-card';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `routinen` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. `WeeklyRecapCard` (issue #431) sits between the
 * heading and today's check-off list — a look back before today's list.
 */
export function HabitsOverviewSection() {
  return (
    <>
      <h2>Gewohnheiten</h2>
      <WeeklyRecapCard />
      <HabitToday />
    </>
  );
}
