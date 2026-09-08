'use client';

import { useState } from 'react';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
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
 */
export function AufgabenView() {
  const [view, setView] = useState<ViewMode>('woche');

  return (
    <>
      <PageHead
        rowClassName="aufgaben-page__title-row"
        eyebrow={<AufgabenCount />}
        extra={<TaskViewSwitcher value={view} onChange={setView} />}
      >
        <h1>Aufgaben</h1>
        <PageFace face="aufgaben" />
      </PageHead>
      <TaskList view={view} />
      <QuickAddTask />
    </>
  );
}
