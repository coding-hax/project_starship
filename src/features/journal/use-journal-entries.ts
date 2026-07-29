'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';
import { listJournalEntries, type JournalEntryView } from './entry';
import { useJournalLock } from './lock-store';

/**
 * The day's entries (issue #376 AC3), newest first — re-decrypts whenever
 * `journal_entries` changes, same `liveQuery` pattern as
 * use-journal-search-entries.ts, so a just-submitted or just-deleted entry shows
 * up without a reload. `useJournalLock()` is a re-render trigger only, so a
 * lock/unlock re-reads with the current DEK. `undefined` before the first pass.
 */
export function useJournalEntries(entryDate: string): JournalEntryView[] | undefined {
  useJournalLock();
  const [entries, setEntries] = useState<JournalEntryView[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const subscription = liveQuery(() =>
      db.records.where('table').equals('journal_entries').toArray(),
    ).subscribe({
      next: () => {
        void listJournalEntries(entryDate).then((loaded) => {
          if (!cancelled) setEntries(loaded);
        });
      },
      error: (error) => console.error('journal entries live query failed', error),
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [entryDate]);

  return entries;
}
