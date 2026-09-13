'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Window size in days — the five values the settings row offers (issue #1184 AK9). */
export type HabitHistoryRangeDays = 30 | 28 | 21 | 14 | 7;

const RANGE_KEY = 'starship:habit-history-range';

const RANGE_DAYS: HabitHistoryRangeDays[] = [30, 28, 21, 14, 7];

const SERVER_SNAPSHOT: HabitHistoryRangeDays = 30;

function readRange(): HabitHistoryRangeDays {
  const stored = Number(localStorage.getItem(RANGE_KEY));
  return RANGE_DAYS.includes(stored as HabitHistoryRangeDays) ? (stored as HabitHistoryRangeDays) : 30;
}

/*
 * Same module-cache + `useSyncExternalStore` pattern as `use-appearance.ts` —
 * a fresh `localStorage.getItem` read every render would return a new value
 * reference each time and defeat memoization in `habit-history-card.tsx`.
 */
let cache: HabitHistoryRangeDays | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): HabitHistoryRangeDays {
  if (cache === null) {
    cache = readRange();
  }
  return cache;
}

function getServerSnapshot(): HabitHistoryRangeDays {
  return SERVER_SNAPSHOT;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * The habit history card's window size (issue #1184, ADR-0006) — a
 * device-local presentation preference like `use-appearance.ts`, deliberately
 * NOT routed through the outbox/IndexedDB (CLAUDE.md rule 8 covers synced
 * domain data, not per-device display prefs): choosing a range never writes
 * an outbox entry (AK10).
 */
export function useHabitHistoryRange() {
  const windowDays = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setWindowDays = useCallback((next: HabitHistoryRangeDays) => {
    localStorage.setItem(RANGE_KEY, String(next));
    cache = next;
    for (const listener of listeners) listener();
  }, []);

  return { windowDays, setWindowDays };
}
