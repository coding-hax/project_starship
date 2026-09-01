'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { TaskList } from './task-list';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `aufgaben` off hides both in one place instead of leaving an
 * orphaned `<h2>` behind. The sheet shows no visible title here (bucket heads
 * — "Überfällig"/"Heute"/"7 Tage", #866 — carry the visible text
 * instead), so the `<h2>` stays visually hidden (issue #972 AK3). The list
 * carries its own `aria-label` (issue #979 AK3) rather than being labelled by
 * this heading — its text ("Aufgaben der nächsten 7 Tage") differs from the
 * heading's ("Aufgaben"), so wiring `aria-labelledby` here would just drop the
 * "der nächsten 7 Tage" part silently.
 */
export function TasksOverviewSection() {
  return (
    <OverviewBlock hiddenTitle="Aufgaben" headingId="uebersicht-aufgaben-heading">
      {/* Embedded in /uebersicht, no scroll container of its own — the list's
          own scroll anchor (issue #88) would scroll the document, not itself
          (issue #647). */}
      <TaskList dueTodayOnly anchorOnMount={false} />
    </OverviewBlock>
  );
}
