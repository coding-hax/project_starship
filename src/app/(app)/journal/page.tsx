import { JournalGate } from '@/features/journal/journal-gate';
import { JournalHeaderDate } from '@/features/journal/journal-header-date';
import { JournalSearchToggle } from '@/features/journal/journal-search-toggle';
import './journal-page.css';

export const metadata = { title: 'Journal · Starship' };

export default function JournalPage() {
  return (
    <div data-module="journal" data-ground="journal">
      <div className="journal-page__title-row">
        <h1>Journal</h1>
        <div className="journal-page__title-actions">
          <JournalHeaderDate />
          <JournalSearchToggle />
        </div>
      </div>
      <JournalGate />
    </div>
  );
}
