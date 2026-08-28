import type { Viewport } from 'next';
import { JournalGate } from '@/features/journal/journal-gate';
import { JournalHeaderDate } from '@/features/journal/journal-header-date';
import { JournalSearchToggle } from '@/features/journal/journal-search-toggle';
import { PageFace } from '@/ui/faces';
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
      <div className="journal-page__title-row">
        <div className="journal-page__title-cluster">
          <h1>Journal</h1>
          <PageFace face="journal" />
        </div>
        <div className="journal-page__title-actions">
          <JournalHeaderDate />
          <JournalSearchToggle />
        </div>
      </div>
      <JournalGate />
    </div>
  );
}
