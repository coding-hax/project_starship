'use client';

import { useCallback, useEffect, useState } from 'react';

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

function readAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return { theme: 'system', reduceMotion: false, textScale: 1 };
  }
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

/**
 * Device-local presentation prefs (ADR-0006). Deliberately NOT routed through the
 * outbox/IndexedDB: these are UI presentation settings, not synced domain data —
 * CLAUDE.md rule 8 (local-first) covers domain mutations, not per-device display
 * prefs. `layout.tsx`'s inline bootstrap script already applies the persisted values
 * before first paint; this hook re-applies them on mount and on every change.
 */
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  const setTheme = useCallback((theme: Theme) => {
    localStorage.setItem(THEME_KEY, theme);
    setAppearance((prev) => ({ ...prev, theme }));
  }, []);

  const setReduceMotion = useCallback((reduceMotion: boolean) => {
    localStorage.setItem(REDUCE_MOTION_KEY, String(reduceMotion));
    setAppearance((prev) => ({ ...prev, reduceMotion }));
  }, []);

  const setTextScale = useCallback((textScale: TextScale) => {
    localStorage.setItem(TEXT_SCALE_KEY, String(textScale));
    setAppearance((prev) => ({ ...prev, textScale }));
  }, []);

  return { ...appearance, setTheme, setReduceMotion, setTextScale };
}
