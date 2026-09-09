'use client';

import { useSyncExternalStore } from 'react';

function subscribe(query: string, callback: () => void): () => void {
  const mql = window.matchMedia(query);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

/**
 * `matchMedia`, hydration-safe. SSR has no viewport to test against, so the
 * server (and therefore the first client render) assumes "no" — same trick
 * `useOnline` uses for `navigator.onLine` — which keeps hydration from
 * discarding and redoing that first render.
 *
 * For breakpoints that only reposition existing markup via CSS (`order`,
 * `display`), the CSS media query alone is enough. This hook is for the rarer
 * case where a component has to make the same breakpoint decision in JS —
 * e.g. moving a node into a slot that must not exist in the DOM at all below
 * the threshold (issue #1117 AK3: `.page-head__extra` has to be entirely
 * absent below 1440px for the pre-existing `seitenkopf.spec.ts` assertions).
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (callback) => subscribe(query, callback),
    () => window.matchMedia(query).matches,
    () => false,
  );
}
