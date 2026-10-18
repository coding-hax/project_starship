'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { TaskList } from './task-list';

/**
 * Overview section wrapper (issue #308) — heading travels with the module, so
 * switching `aufgaben` off hides it in one place instead of leaving an
 * orphaned `<h2>` behind. Unlike every other module, this one's heading isn't
 * `OverviewBlock`'s own `hiddenTitle` (issue #1217 AK2): while the list is
 * filled, the bucket heads — "Überfällig"/"Heute"/"7 Tage", #866 — carry the
 * visible text instead and the "Aufgaben" heading stays hidden same as
 * before (#972 AK3); but once nothing is due, the empty state gets its own
 * card with a visible "Aufgaben" head (AK1), and a *second*, hidden "Aufgaben"
 * heading alongside it would be a duplicate. `TaskList` is the one that knows
 * which of the two applies on any given render, so it owns the heading itself
 * now — `headingId` just tells it which id to put on whichever one it
 * renders. The list carries its own `aria-label` (issue #979 AK3) rather than
 * being labelled by this heading — its text ("Aufgaben der nächsten 7 Tage")
 * differs from the heading's ("Aufgaben"), so wiring `aria-labelledby` here
 * would just drop the "der nächsten 7 Tage" part silently.
 */
export function TasksOverviewSection() {
  return (
    <OverviewBlock section="aufgaben">
      {/* Embedded in /uebersicht, no scroll container of its own — the list's
          own scroll anchor (issue #88) would scroll the document, not itself
          (issue #647). */}
      <TaskList dueTodayOnly anchorOnMount={false} headingId="uebersicht-aufgaben-heading" />
    </OverviewBlock>
  );
}
