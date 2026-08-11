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

/** A `PresenceStep` plus the subject it was computed for — see `resetKey` below. */
interface PresenceState<T> extends PresenceStep<T> {
  resetKey: string | undefined;
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

/**
 * Every item as a settled `present` row — no enter, no leave (issue #611).
 *
 * Used when the caller swaps the list's *subject* rather than its contents
 * (`resetKey` below): the previous rows are not departures that earned an exit
 * animation, they belong to something the user is no longer looking at.
 */
export function seedPresenceEntries<T>(
  items: T[],
  getKey: (item: T) => string,
): ListPresenceEntry<T>[] {
  return items.map((item) => ({ key: getKey(item), item, status: 'present' as const }));
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
 *
 * `resetKey` names *what the list is about* — the calendar day a timeline
 * shows, say. Changing it swaps the whole list rather than adding to or
 * removing from it, so the old rows are dropped outright and the new ones seed
 * as `present` (issue #611). Without it, paging from one day to the next let
 * yesterday's cards linger over today's for the length of the exit animation,
 * because a key missing from the next snapshot is indistinguishable from a
 * deleted row. Two things have to happen for that, and the second is easy to
 * miss: the seed is what this render *returns*, not just what the effect
 * below stores — the effect runs after the paint, so a state-only reset would
 * still show one frame of the old day. Callers whose list keeps a single
 * subject for its lifetime (tasks, habits) leave it undefined and keep the
 * pure add/remove behaviour.
 */
export function useListPresence<T>(
  items: T[],
  getKey: (item: T) => string,
  resetKey?: string,
): ListPresenceRow<T>[] {
  const getKeyRef = useRef(getKey);
  // No dependency array: this needs to run after *every* render, purely to keep
  // the ref current — a plain assignment during render is a lint error (refs
  // aren't render values), so the sync happens here instead.
  useEffect(() => {
    getKeyRef.current = getKey;
  });
  const [state, setState] = useState<PresenceState<T>>(() => ({
    entries: [],
    established: false,
    resetKey,
  }));

  useEffect(() => {
    setState((prev) => {
      if (prev.resetKey !== resetKey) {
        return {
          entries: seedPresenceEntries(items, getKeyRef.current),
          // A list that was already established stays established across the
          // swap: landing on an empty day is a settled answer, not the
          // "still loading" ambiguity nextPresenceEntries has to guess at, so
          // a row arriving afterwards is a real addition and may animate in.
          established: prev.established || items.length > 0,
          resetKey,
        };
      }
      const step = nextPresenceEntries(prev.entries, prev.established, items, getKeyRef.current);
      return { entries: step.entries, established: step.established, resetKey };
    });
  }, [items, resetKey]);

  function handleAnimationEnd(key: string) {
    setState((prev) => ({ ...prev, entries: settlePresenceEntry(prev.entries, key) }));
  }

  // `getKey` straight from the arguments here, not `getKeyRef` — this runs
  // during render, where reading a ref is both a lint error and pointless: the
  // prop itself is the current value, the ref only exists to keep the effect
  // below off `getKey`'s ever-changing identity.
  const entries = state.resetKey === resetKey ? state.entries : seedPresenceEntries(items, getKey);

  return entries.map((entry) => ({ ...entry, onAnimationEnd: () => handleAnimationEnd(entry.key) }));
}
