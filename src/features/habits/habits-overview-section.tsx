'use client';

import { HabitToday } from './habit-today';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `gewohnheiten` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind.
 */
export function HabitsOverviewSection() {
  return (
    <>
      <h2>Gewohnheiten</h2>
      <HabitToday />
    </>
  );
}
