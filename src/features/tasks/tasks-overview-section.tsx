'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { TaskList } from './task-list';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `aufgaben` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. The sheet shows no visible title here (bucket heads
 * — "Überfällig"/"Heute"/"7 Tage", #866 — carry the visible text
 * instead), so the `<h2>` stays visually hidden (issue #972 AK3).
 */
export function TasksOverviewSection() {
  return (
    <OverviewBlock hiddenTitle="Aufgaben" headingId="uebersicht-aufgaben-heading">
      {/* Embedded in /uebersicht, no scroll container of its own — the list's
          own scroll anchor (issue #88) would scroll the document, not itself
          (issue #647). */}
      <TaskList dueTodayOnly headingId="uebersicht-aufgaben-heading" anchorOnMount={false} />
    </OverviewBlock>
  );
}
