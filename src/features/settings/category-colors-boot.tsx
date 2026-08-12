'use client';

import { useEffect } from 'react';
import { useCategoryColors } from './use-category-colors';

/**
 * Applies chosen category-colour overrides as inline `var()` references on
 * `<html>` (issue #660 AC4/AC7) — a *reference*, never a value resolved via
 * `getComputedStyle`, so the override keeps picking up the light/dark value of
 * the chosen `--swatch-*` token automatically instead of freezing whichever
 * theme happened to be active when it was set. `categoryEdgeVar()`
 * (src/features/events/event-time.ts) and every CSS rule that reads
 * `var(--cat-<category>)` stay untouched — this only ever shadows the
 * tokens.css default on the root element (AC5: no row, no override).
 *
 * Both the category and the token come out of `useCategoryColors()` already
 * checked against the fixed category list / `SWATCH_PALETTE` allowlist, so
 * nothing arbitrary ever reaches `setProperty`.
 *
 * `layout.tsx` is a server component, so this lives next to `SyncBoot` as its
 * own client component. Renders nothing.
 */
export function CategoryColorsBoot() {
  const { colors } = useCategoryColors();

  useEffect(() => {
    if (colors === undefined) return;
    const root = document.documentElement;
    for (const view of colors) {
      const property = `--cat-${view.category}`;
      if (view.color) {
        root.style.setProperty(property, `var(${view.color})`);
      } else {
        root.style.removeProperty(property);
      }
    }
  }, [colors]);

  return null;
}
