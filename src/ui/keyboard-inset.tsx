'use client';

import { useEffect } from 'react';

/**
 * Keeps `--keyboard-inset` on <html> in sync with the height the on-screen keyboard
 * covers, so bottom-anchored UI (FAB, sheet, toast) can lift above it.
 *
 * Why not just CSS: iOS Safari does not shrink the layout viewport for the keyboard
 * and ignores the `interactive-widget` viewport hint, so `dvh`/`vh` stay put and the
 * input slides behind the keyboard. `window.visualViewport` is the only signal that
 * moves on every platform — its `height` excludes the keyboard, so the difference to
 * `innerHeight` (minus any in-viewport scroll) is what the keyboard covers.
 *
 * Renders nothing. Cleans the property up on unmount so nothing leaks a stale inset.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);

  return null;
}
