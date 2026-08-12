'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { TaskList } from './task-list';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `aufgaben` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. Heading row via `OverviewBlock` (issue #652).
 */
export function TasksOverviewSection() {
  return (
    <OverviewBlock title="Aufgaben" area="var(--area-tasks)" headingId="uebersicht-aufgaben-heading">
      <TaskList dueTodayOnly headingId="uebersicht-aufgaben-heading" />
    </OverviewBlock>
  );
}
