'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { migrateModuleIds } from '@/modules/module-ids';
import { NAV_ITEMS, type NavItem } from '@/ui/nav-items';

const ORDER_KEY = 'starship:nav-order';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readOrder(): string[] {
  const raw = localStorage.getItem(ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // Mapped on read, never written back: `resolveOrder()` drops ids it does not know,
    // so without this a renamed module loses its stored position and gets re-appended
    // at the end of the carousel. The stored value heals itself on the next reorder,
    // because `write()` persists the already-mapped snapshot.
    return isStringArray(parsed) ? migrateModuleIds(parsed) : [];
  } catch {
    return [];
  }
}

/**
 * Known ids in their stored order, unknown ids dropped, ids missing from `stored`
 * appended at the end in `items`' own order — so a nav entry added later (#180's
 * Garmin tab) shows up instead of vanishing, and a stale id left over from a removed
 * entry never produces a gap.
 */
export function resolveOrder<T extends { id: string }>(stored: string[], items: readonly T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const known = stored.filter((id) => byId.has(id));
  const missing = items.filter((item) => !known.includes(item.id));
  return [...known.map((id) => byId.get(id)!), ...missing];
}

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): string[] {
  if (cache === null) {
    cache = readOrder();
  }
  return cache;
}

// A stable reference, not a fresh `[]` each call — same reason as
// use-appearance.ts's SERVER_SNAPSHOT: useSyncExternalStore compares by reference,
// and a new array every render trips React's "getServerSnapshot should be cached"
// warning (and the busy-loop behind it) even though nothing actually changed.
const EMPTY_ORDER: string[] = [];

function getServerSnapshot(): string[] {
  return EMPTY_ORDER;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function write(next: string[]) {
  cache = next;
  localStorage.setItem(ORDER_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

/**
 * Device-local nav order (issue #205), same pattern as `use-weather-location.ts`:
 * only the id list is persisted, never labels or routes, and it never touches the
 * outbox — this is a display preference, not synced domain data (CLAUDE.md rule 8
 * covers writes to domain data, not per-device UI order).
 */
export function useNavOrder() {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const items = resolveOrder(stored, NAV_ITEMS);

  const move = useCallback((id: string, delta: -1 | 1) => {
    const current = resolveOrder(getSnapshot(), NAV_ITEMS).map((item) => item.id);
    const index = current.indexOf(id);
    const swapWith = index + delta;
    if (index < 0 || swapWith < 0 || swapWith >= current.length) return;
    [current[index], current[swapWith]] = [current[swapWith], current[index]];
    write(current);
  }, []);

  const moveUp = useCallback((id: string) => move(id, -1), [move]);
  const moveDown = useCallback((id: string) => move(id, 1), [move]);

  return { items, moveUp, moveDown };
}

export type { NavItem };
