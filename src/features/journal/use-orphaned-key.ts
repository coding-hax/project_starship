'use client';

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db } from '@/local/dexie';
import { logJournalQueryError } from './log-query-error';

/**
 * Whether this device is currently holding a displaced `journal_keys` envelope
 * (issue #518) — drives the recovery affordance's visibility in the editor.
 * `liveQuery`, same pattern as `use-journal-entries.ts`. Recovery GCs the stash
 * as part of the same operation that reports how many entries it found, so this
 * flips to `false` right away — `JournalOrphanedKeyCard` keeps itself mounted
 * a moment longer via its own `message` state so that count is still readable.
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
