'use client';

import { useState } from 'react';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import { useMinWidth } from '@/ui/use-min-width';
import { AufgabenCount } from './aufgaben-count';
import { QuickAddTask } from './quick-add';
import { TaskList, TaskViewSwitcher, type ViewMode } from './task-list';

/**
 * `/aufgaben`'s body (issue #1117 AK3): a client wrapper around `PageHead` +
 * `TaskList` so the two can share the `view` state — from 1440px the
 * Woche/Alle/Erledigt switcher moves into `PageHead`'s `extra` slot instead
 * of its own row below the header, which means the state that drives it has
 * to live above both. `page.tsx` stays a server component for its
 * `metadata`/`viewport` exports, the same split `JournalPageHead` uses.
 *
 * The move is structural, not just CSS `order` (unlike the rest of #1117):
 * `PageHead` only renders `.page-head__extra` at all when its `extra` prop is
 * given, and the pre-existing `seitenkopf.spec.ts` AK2 (#868) asserts that
 * wrapper has zero count on `/aufgaben` below the breakpoint — issue #1117's
 * own AK6 requires that spec stay green untouched. So `useMinWidth` decides
 * in JS which single spot the switcher actually mounts in, instead of
 * rendering it twice and hiding one copy with CSS (`display: none` would
 * still leave the node in the DOM and fail that count).
 */
export function AufgabenView() {
  const [view, setView] = useState<ViewMode>('woche');
  const isWide = useMinWidth(1440);
  const switcher = <TaskViewSwitcher value={view} onChange={setView} />;

  return (
    <>
      <PageHead
        rowClassName="aufgaben-page__title-row"
        eyebrow={<AufgabenCount />}
        extra={isWide ? switcher : undefined}
      >
        <h1>Aufgaben</h1>
        <PageFace face="aufgaben" />
      </PageHead>
      {!isWide && switcher}
      <TaskList view={view} />
      <QuickAddTask />
    </>
  );
}
