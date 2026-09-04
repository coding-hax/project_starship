import type { Viewport } from 'next';
import { JournalGate } from '@/features/journal/journal-gate';
import { JournalPageHead } from '@/features/journal/journal-page-head';
import './journal-page.css';

export const metadata = { title: 'Journal · Starship' };

// Android status bar colour (issue #882, AK4) — see uebersicht/page.tsx.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#7e67a1' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
};

export default function JournalPage() {
  return (
    <div data-module="journal" data-ground="journal">
      <JournalPageHead />
      <JournalGate />
    </div>
  );
}
