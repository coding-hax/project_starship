'use client';

import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import { TodayLongDate } from '@/ui/today-long-date';
import { JournalSearchBar } from './journal-search-bar';
import { JournalSearchChips } from './journal-search-chips';
import { JournalSearchToggle } from './journal-search-toggle';
import { useJournalSearchMode } from './journal-view-mode';

/**
 * Journal's PageHead wiring (issue #1051 AK1/AK2): swaps the eyebrow between
 * date+lupe and the search pill, and only shows the filter chips (extra slot)
 * while search mode is open. Its own client component because page.tsx stays
 * a server component for its `metadata`/`viewport` exports — a hook here
 * couldn't otherwise decide what page.tsx passes into `<PageHead>`.
 */
export function JournalPageHead() {
  const { active } = useJournalSearchMode();

  return (
    <PageHead
      rowClassName="journal-page__title-row"
      eyebrow={
        <div className="journal-page__eyebrow-row">
          {active ? (
            <JournalSearchBar />
          ) : (
            <>
              <TodayLongDate />
              <JournalSearchToggle />
            </>
          )}
        </div>
      }
      extra={active ? <JournalSearchChips /> : undefined}
    >
      <h1 className="journal-page__heading">Wie war dein Tag?</h1>
      <PageFace face="journal" />
    </PageHead>
  );
}
