import { JournalGate } from '@/features/journal/journal-gate';
import { JournalHeaderDate } from '@/features/journal/journal-header-date';
import './journal-page.css';

export const metadata = { title: 'Journal · Starship' };

export default function JournalPage() {
  return (
    <div data-module="journal">
      <div className="journal-page__title-row">
        <h1>Journal</h1>
        <JournalHeaderDate />
      </div>
      <JournalGate />
    </div>
  );
}
