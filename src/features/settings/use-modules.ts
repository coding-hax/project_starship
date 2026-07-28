'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { MODULES } from '@/modules/registry';

const MODULES_OFF_KEY = 'starship:modules-off';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readOff(): string[] {
  const raw = localStorage.getItem(MODULES_OFF_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): string[] {
  if (cache === null) {
    cache = readOff();
  }
  return cache;
}

// Stable reference, not a fresh `[]` each call — same reason as use-nav-order.ts's
// EMPTY_ORDER: useSyncExternalStore compares by reference.
const EMPTY_OFF: string[] = [];

function getServerSnapshot(): string[] {
  return EMPTY_OFF;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function write(next: string[]) {
  cache = next;
  localStorage.setItem(MODULES_OFF_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

/**
 * Device-local module on/off state (ADR-0012, issue #307), same pattern as
 * `use-nav-order.ts`: an **exclusion list** of off ids, so a module added later ships
 * active by default without touching every device's stored state. Pure display — never
 * touches Dexie/outbox (CLAUDE.md rule 8 covers domain data writes, not this per-device
 * preference), and `core` modules can never end up in the list.
 */
export function useModules() {
  const off = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const isActive = useCallback((id: string) => !off.includes(id), [off]);

  const toggle = useCallback((id: string) => {
    const target = MODULES.find((m) => m.id === id);
    if (!target || target.core) return;
    const current = getSnapshot();
    write(current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }, []);

  return { modules: MODULES.filter((m) => !m.core), isActive, toggle };
}
