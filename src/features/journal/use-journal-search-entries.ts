import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';
import { loadSearchableJournalEntries } from './journal-search-cache';
import type { JournalSearchEntry } from './search';

/**
 * The session cache search reads from (AC2, owner decision "3a" in #301):
 * re-decrypts every `journal_entries` row whenever the table changes — same
 * `liveQuery` pattern as use-journal-conflicts.ts — so an entry saved moments
 * ago is searchable right away, not just after a reload. Nothing here ever
 * reaches IndexedDB; only this hook's React state holds the plaintext, gone
 * the moment the component is. `undefined` while locked or before the first
 * decrypt has landed — the caller renders nothing for it (no loading UI, AC4).
 */
export function useJournalSearchEntries(): JournalSearchEntry[] | undefined {
  const [entries, setEntries] = useState<JournalSearchEntry[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const subscription = liveQuery(() =>
      db.records.where('table').equals('journal_entries').toArray(),
    ).subscribe({
      next: () => {
        void loadSearchableJournalEntries().then((loaded) => {
          if (!cancelled) setEntries(loaded);
        });
      },
      error: (error) => console.error('journal search live query failed', error),
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return entries;
}
