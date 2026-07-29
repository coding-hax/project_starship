'use client';

import { useCallback, useSyncExternalStore } from 'react';

const JOURNAL_PERSIST_KEY = 'starship:journal-persist';

export function readJournalPersistPref(): boolean {
  return localStorage.getItem(JOURNAL_PERSIST_KEY) === 'true';
}

let cache: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (cache === null) {
    cache = readJournalPersistPref();
  }
  return cache;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Exported separately from the hook — `lock-store.ts` reacts to a toggle flip
 * (persist/clear the in-memory DEK) without itself being a React hook. */
export function subscribeJournalPersistPref(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * Device-local opt-in (issue #339 AC5), Muster wie use-capture-prefs.ts: eine
 * Geräte-Präferenz, kein synchronisiertes Domänendatum (CLAUDE.md Regel 8 gilt
 * für Mutationen, nicht für dieses reine Anzeigeverhalten). Default AUS.
 */
export function useJournalPersistPref() {
  const enabled = useSyncExternalStore(subscribeJournalPersistPref, getSnapshot, getServerSnapshot);

  const setEnabled = useCallback((value: boolean) => {
    localStorage.setItem(JOURNAL_PERSIST_KEY, String(value));
    cache = value;
    for (const listener of listeners) listener();
  }, []);

  return { enabled, setEnabled };
}
