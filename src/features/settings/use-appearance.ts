'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'system' | 'hell' | 'dunkel';
export type TextScale = 0.9 | 1 | 1.1 | 1.25;

const THEME_KEY = 'starship:theme';
const REDUCE_MOTION_KEY = 'starship:reduce-motion';
const TEXT_SCALE_KEY = 'starship:text-scale';

const TEXT_SCALES: TextScale[] = [0.9, 1, 1.1, 1.25];

interface Appearance {
  theme: Theme;
  reduceMotion: boolean;
  textScale: TextScale;
}

const SERVER_SNAPSHOT: Appearance = { theme: 'system', reduceMotion: false, textScale: 1 };

function readAppearance(): Appearance {
  const theme = localStorage.getItem(THEME_KEY);
  const textScale = Number(localStorage.getItem(TEXT_SCALE_KEY));
  return {
    theme: theme === 'hell' || theme === 'dunkel' ? theme : 'system',
    reduceMotion: localStorage.getItem(REDUCE_MOTION_KEY) === 'true',
    textScale: TEXT_SCALES.includes(textScale as TextScale) ? (textScale as TextScale) : 1,
  };
}

function applyAppearance(appearance: Appearance) {
  const html = document.documentElement;
  if (appearance.theme === 'system') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', appearance.theme);
  }
  if (appearance.reduceMotion) {
    html.setAttribute('data-reduce-motion', 'true');
  } else {
    html.removeAttribute('data-reduce-motion');
  }
  html.style.setProperty('--font-scale', String(appearance.textScale));
}

/*
 * `useSyncExternalStore` needs a snapshot that's referentially stable between calls
 * unless the underlying value actually changed — reading localStorage fresh every
 * render would return a new object each time and never stop re-rendering. `cache`
 * holds the last known value; `write` (called only from the setters below, i.e. only
 * on the client) is the one place that replaces it and notifies subscribers.
 */
let cache: Appearance | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Appearance {
  if (cache === null) {
    cache = readAppearance();
  }
  return cache;
}

function getServerSnapshot(): Appearance {
  return SERVER_SNAPSHOT;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function write(next: Appearance) {
  cache = next;
  applyAppearance(next);
  for (const listener of listeners) listener();
}

/**
 * Device-local presentation prefs (ADR-0006). Deliberately NOT routed through the
 * outbox/IndexedDB: these are UI presentation settings, not synced domain data —
 * CLAUDE.md rule 8 (local-first) covers domain mutations, not per-device display
 * prefs. `layout.tsx`'s inline bootstrap script applies the persisted values to
 * <html> before first paint; `useSyncExternalStore` is what lets the *controls*
 * (Toggle/SegmentedControl/Slider) pick up the same localStorage value right after
 * hydration without a mismatch — a plain `useState(() => readLocalStorage())` looks
 * equivalent but leaves the server-rendered ("false") attribute stuck in the DOM,
 * because hydration doesn't reliably re-patch attributes that already "match"
 * structurally.
 */
export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((theme: Theme) => {
    localStorage.setItem(THEME_KEY, theme);
    write({ ...getSnapshot(), theme });
  }, []);

  const setReduceMotion = useCallback((reduceMotion: boolean) => {
    localStorage.setItem(REDUCE_MOTION_KEY, String(reduceMotion));
    write({ ...getSnapshot(), reduceMotion });
  }, []);

  const setTextScale = useCallback((textScale: TextScale) => {
    localStorage.setItem(TEXT_SCALE_KEY, String(textScale));
    write({ ...getSnapshot(), textScale });
  }, []);

  return { ...appearance, setTheme, setReduceMotion, setTextScale };
}
