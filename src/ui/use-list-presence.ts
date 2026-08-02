'use client';

import { useEffect, useRef, useState } from 'react';

export type ListPresenceStatus = 'entering' | 'present' | 'leaving';

export interface ListPresenceEntry<T> {
  key: string;
  item: T;
  status: ListPresenceStatus;
}

export interface ListPresenceRow<T> extends ListPresenceEntry<T> {
  onAnimationEnd: () => void;
}

interface PresenceStep<T> {
  entries: ListPresenceEntry<T>[];
  established: boolean;
}

/**
 * Pure diff step, exported for the Vitest unit (issue #430) — the hook below is
 * just a thin useState/useEffect wrapper around it.
 *
 * `established` stays false across the initial loading renders (Dexie live
 * queries return `undefined`/`[]` until the first read lands), so the array that
 * eventually shows up as the *first* non-empty snapshot seeds every row as
 * `present`, never `entering` — animating a page load would violate
 * DESIGN_SYSTEM.md's "never nag on every use". A row added to a list that
 * genuinely starts out empty is the one edge case that trades a per-item enter
 * animation for that guarantee; the ambiguity is unavoidable without a caller
 * signalling "the query settled, and it settled empty" separately from "still
 * loading".
 *
 * Once established, a key missing from `items` moves to `leaving` and keeps its
 * last known `item` (and its position) so the removed row can still animate out
 * before `settlePresenceEntry` drops it after the exit animation ends. A key
 * that reappears mid-`leaving` (should not happen for these lists, e.g. no
 * "delete" is a toggle) is treated as unchanged rather than restarting `entering`.
 */
export function nextPresenceEntries<T>(
  prevEntries: ListPresenceEntry<T>[],
  established: boolean,
  items: T[],
  getKey: (item: T) => string,
): PresenceStep<T> {
  if (!established) {
    if (items.length === 0) return { entries: prevEntries, established: false };
    return {
      entries: items.map((item) => ({ key: getKey(item), item, status: 'present' as const })),
      established: true,
    };
  }

  const nextByKey = new Map(items.map((item) => [getKey(item), item] as const));
  const prevKeys = new Set(prevEntries.map((entry) => entry.key));

  const merged: ListPresenceEntry<T>[] = [];
  for (const entry of prevEntries) {
    const nextItem = nextByKey.get(entry.key);
    if (nextItem !== undefined) {
      merged.push({
        key: entry.key,
        item: nextItem,
        status: entry.status === 'leaving' ? 'present' : entry.status,
      });
    } else if (entry.status !== 'leaving') {
      merged.push({ ...entry, status: 'leaving' });
    } else {
      merged.push(entry);
    }
  }

  let cursor = 0;
  for (const item of items) {
    const key = getKey(item);
    if (prevKeys.has(key)) {
      cursor = merged.findIndex((entry) => entry.key === key) + 1;
      continue;
    }
    merged.splice(cursor, 0, { key, item, status: 'entering' });
    cursor += 1;
  }

  return { entries: merged, established: true };
}

/** Called from a row's `onAnimationEnd` — `entering` settles to `present`, a
 * settled `leaving` row is finally dropped. Any other status is untouched, so a
 * stray animationend (e.g. from an unrelated child animation bubbling up) is a
 * no-op rather than a wrong transition. */
export function settlePresenceEntry<T>(
  entries: ListPresenceEntry<T>[],
  key: string,
): ListPresenceEntry<T>[] {
  return entries
    .map((entry) =>
      entry.key === key && entry.status === 'entering'
        ? { ...entry, status: 'present' as const }
        : entry,
    )
    .filter((entry) => !(entry.key === key && entry.status === 'leaving'));
}

/**
 * Tracks enter/leave transitions for a keyed list so a row React would otherwise
 * unmount instantly can still play a CSS exit animation first (issue #430) —
 * `@starting-style` alone only covers the entry side, a React unmount gives it
 * nothing to transition on the way out.
 *
 * Callers must pass a referentially stable `items` array (e.g. `useMemo` keyed
 * on the underlying live-query result) — a fresh array/object identity on every
 * render, even with identical content, is read as "changed" and defeats the
 * "only animate real additions/removals" guarantee.
 *
 * `getKey` is deliberately *not* a dependency of the effect below, only read
 * through a ref — callers pass it as an inline arrow (`h => h.id`), a fresh
 * function identity on every render. Depending on it directly, with a stable
 * `items`, still re-ran the effect (and its `setEntries`) on every render,
 * which re-ran the component, which recreated `getKey` again: an infinite
 * update loop (issue #430, caught by the habits/journal Playwright specs —
 * "Maximum update depth exceeded", 32 duplicate rows). The value itself is
 * always a trivial, stable-in-spirit id lookup, so re-running the diff only
 * when `items` actually changes is correct, not a staleness risk.
 */
export function useListPresence<T>(items: T[], getKey: (item: T) => string): ListPresenceRow<T>[] {
  const establishedRef = useRef(false);
  const getKeyRef = useRef(getKey);
  // No dependency array: this needs to run after *every* render, purely to keep
  // the ref current — a plain assignment during render is a lint error (refs
  // aren't render values), so the sync happens here instead.
  useEffect(() => {
    getKeyRef.current = getKey;
  });
  const [entries, setEntries] = useState<ListPresenceEntry<T>[]>([]);

  useEffect(() => {
    setEntries((prev) => {
      const step = nextPresenceEntries(prev, establishedRef.current, items, getKeyRef.current);
      establishedRef.current = step.established;
      return step.entries;
    });
  }, [items]);

  function handleAnimationEnd(key: string) {
    setEntries((prev) => settlePresenceEntry(prev, key));
  }

  return entries.map((entry) => ({ ...entry, onAnimationEnd: () => handleAnimationEnd(entry.key) }));
}
