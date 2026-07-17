'use client';

import { useCallback, useSyncExternalStore } from 'react';

const DIRECT_CAPTURE_KEY = 'starship:capture-direct';

function readDirectCapture(): boolean {
  return localStorage.getItem(DIRECT_CAPTURE_KEY) === 'true';
}

let cache: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (cache === null) {
    cache = readDirectCapture();
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
 * Device-local Erfassungs-Einstellung (issue #47 AC3), Muster wie
 * use-appearance.ts: eine Geräte-Präferenz, kein synchronisiertes Domänendatum
 * (CLAUDE.md rule 8 gilt für Mutationen, nicht für Anzeige-/Erfassungsverhalten).
 * Anders als das Theme wird dieser Wert nur zur Erfassungszeit gelesen — kein
 * Inline-Bootstrap vor dem ersten Paint nötig.
 */
export function useCapturePrefs() {
  const directCapture = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setDirectCapture = useCallback((value: boolean) => {
    localStorage.setItem(DIRECT_CAPTURE_KEY, String(value));
    cache = value;
    for (const listener of listeners) listener();
  }, []);

  return { directCapture, setDirectCapture };
}
