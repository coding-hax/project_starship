import { JournalGate } from '@/features/journal/journal-gate';

export const metadata = { title: 'Journal · Starship' };

export default function JournalPage() {
  return (
    <div data-module="journal">
      <h1>Journal</h1>
      <JournalGate />
    </div>
  );
}
