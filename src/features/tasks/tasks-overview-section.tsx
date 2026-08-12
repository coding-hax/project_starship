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
      {/* Embedded in /uebersicht, no scroll container of its own — the list's
          own scroll anchor (issue #88) would scroll the document, not itself
          (issue #647). */}
      <TaskList dueTodayOnly headingId="uebersicht-aufgaben-heading" anchorOnMount={false} />
    </OverviewBlock>
  );
}
