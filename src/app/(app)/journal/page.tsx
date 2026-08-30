import type { Viewport } from 'next';
import { JournalGate } from '@/features/journal/journal-gate';
import { JournalHeadMood } from '@/features/journal/journal-head-mood';
import { JournalSearchToggle } from '@/features/journal/journal-search-toggle';
import { PageFace } from '@/ui/faces';
import { PageHead } from '@/ui/page-head';
import { TodayLongDate } from '@/ui/today-long-date';
import './journal-page.css';

export const metadata = { title: 'Journal · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#4a1d78' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function JournalPage() {
  return (
    <div data-module="journal" data-ground="journal">
      <PageHead
        rowClassName="journal-page__title-row"
        eyebrow={
          <div className="journal-page__eyebrow-row">
            <TodayLongDate />
            <JournalSearchToggle />
          </div>
        }
        extra={<JournalHeadMood />}
      >
        <h1 className="journal-page__heading">Wie war dein Tag?</h1>
        <PageFace face="journal" />
      </PageHead>
      <JournalGate />
    </div>
  );
}
