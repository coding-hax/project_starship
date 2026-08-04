'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';
import { logJournalQueryError } from './log-query-error';

/**
 * Whether this device is currently holding a displaced `journal_keys` envelope
 * (issue #518) — drives the recovery affordance's visibility in the editor.
 * `liveQuery`, same pattern as `use-journal-entries.ts`, so a just-recovered
 * (and GC'd) stash hides the affordance again without a reload.
 */
export function useOrphanedKey(): boolean {
  const [hasStash, setHasStash] = useState(false);

  useEffect(() => {
    const subscription = liveQuery(() => db.journalKeyStash.count()).subscribe({
      next: (count) => setHasStash(count > 0),
      error: () => logJournalQueryError('journal key stash live query failed'),
    });
    return () => subscription.unsubscribe();
  }, []);

  return hasStash;
}
