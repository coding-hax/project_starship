import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db, type JournalConflict } from '@/local/dexie';

/** Live query on `journalConflicts` for one day (issue #338 AC6/#340 AC8) — same
 * `liveQuery` pattern as `use-live-table.ts`, but against its own store rather
 * than the generic `records` table. `undefined` while the first read is in
 * flight, then always an array. */
export function useJournalConflicts(entryDate: string): JournalConflict[] | undefined {
  const [conflicts, setConflicts] = useState<JournalConflict[] | undefined>(undefined);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.journalConflicts.where('entryDate').equals(entryDate).toArray(),
    ).subscribe({
      next: setConflicts,
      error: (error) => console.error('journal conflicts live query failed', error),
    });

    return () => subscription.unsubscribe();
  }, [entryDate]);

  return conflicts;
}
