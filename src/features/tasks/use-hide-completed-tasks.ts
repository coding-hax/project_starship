'use client';

import { useCallback, useSyncExternalStore } from 'react';

const HIDE_COMPLETED_KEY = 'starship:tasks-hide-completed';

function readHideCompleted(): boolean {
  return localStorage.getItem(HIDE_COMPLETED_KEY) === 'true';
}

let cache: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (cache === null) {
    cache = readHideCompleted();
  }
  return cache;
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * Device-local Aufgaben-Präferenz (issue #654 AC4), Muster wie
 * use-capture-prefs.ts: reine Anzeige-Einstellung, kein Sync, kein
 * Outbox-Eintrag (CLAUDE.md Regel 8 gilt für Mutationen, nicht dafür).
 */
export function useHideCompletedTasks() {
  const hideCompleted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setHideCompleted = useCallback((value: boolean) => {
    localStorage.setItem(HIDE_COMPLETED_KEY, String(value));
    cache = value;
    for (const listener of listeners) listener();
  }, []);

  return { hideCompleted, setHideCompleted };
}
