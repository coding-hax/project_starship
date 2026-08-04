'use client';

import { useEffect } from 'react';
import { useModules } from '@/features/settings/use-modules';
import { getMeta, META_LAST_PULLED_SEQ } from '@/local/dexie';
import { sync } from '@/local/sync';
import { ensureJournalHabit } from './journal-habit';

/**
 * Idempotently creates the Journal habit row (issue #505 AC1) once this device
 * has pulled at least once — never before, or a brand-new device on an
 * existing account could `ensure` (and clobber, per push/route.ts arrival-wins)
 * a rhythm/archive state already chosen elsewhere before the real row arrives
 * via `pull()`. A fresh account's first (empty) pull sets the cursor to `0`,
 * which is enough to tell "we asked" from "we never asked".
 *
 * `layout.tsx` is a server component, so this lives next to `SyncBoot` as its
 * own client component. Renders nothing.
 */
export function JournalHabitBoot() {
  const { isActive } = useModules();

  useEffect(() => {
    if (!isActive('journal')) return;

    let cancelled = false;
    void (async () => {
      await sync();
      const seq = await getMeta<number>(META_LAST_PULLED_SEQ);
      if (cancelled || seq == null) return;
      await ensureJournalHabit();
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive]);

  return null;
}
