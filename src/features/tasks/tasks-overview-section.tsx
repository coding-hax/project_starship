'use client';

import { TaskList } from './task-list';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `aufgaben` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind.
 */
export function TasksOverviewSection() {
  return (
    <>
      <h2 id="uebersicht-aufgaben-heading">Aufgaben</h2>
      <TaskList dueTodayOnly headingId="uebersicht-aufgaben-heading" />
    </>
  );
}
