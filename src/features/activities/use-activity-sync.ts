'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Keeps the activities page fresh without waiting for the nightly Actions cron
 * (issue #230). Same shape as `use-weather-forecast.ts` — a freshness window plus
 * a visible-tab-only interval — with one deliberate difference: the client never
 * talks to Garmin itself. It cannot (the OAuth1 token has a ~1 year lifetime and
 * belongs in Postgres, `connectapi.garmin.com` is not a browser origin, and the
 * map key is a server env). It only asks our own `/api/garmin-sync`, which already
 * accepts an owner session besides the cron secret (ADR-0011).
 *
 * The data path is unchanged: the endpoint writes Postgres, the normal pull carries
 * it into IndexedDB, and the list renders from there (CLAUDE.md rule 8). The
 * response body is never rendered — it only carries counters.
 */

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Device-local, like the weather location (`use-weather-location.ts`): what this
 * browser last pulled is nothing to reconcile between devices, so it stays out of
 * Dexie — and out of `src/local/`, which is a protected path.
 */
const LAST_SYNC_KEY = 'starship:garmin-synced-at';

let cache: string | null | undefined;
const listeners = new Set<() => void>();

function readLastSyncAt(): string | null {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  if (!raw) return null;
  // A hand-edited or half-written value must not make the caption render `NaN:NaN`.
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

function getSnapshot(): string | null {
  if (cache === undefined) cache = readLastSyncAt();
  return cache;
}

function getServerSnapshot(): string | null {
  return null;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function writeLastSyncAt(value: string): void {
  localStorage.setItem(LAST_SYNC_KEY, value);
  cache = value;
  for (const listener of listeners) listener();
}

function isFresh(lastSyncAt: string | null, now: number): boolean {
  if (lastSyncAt === null) return false;
  return now - new Date(lastSyncAt).getTime() < REFRESH_INTERVAL_MS;
}

/**
 * One attempt. Inside the freshness window it does nothing at all, so firing
 * several triggers at once (focus right after visibilitychange) costs at most one
 * real request — the same guarantee `refreshIfStale` gives the weather page.
 *
 * A failure — 409 (bootstrap fällig), 5xx, offline — leaves the stored timestamp
 * untouched on purpose (ADR-0009, Punkt 3): the list keeps showing what it had,
 * and the timestamp keeps ageing until it crosses the 8h mark and the caption
 * says so.
 */
async function refreshIfStale(): Promise<void> {
  if (isFresh(getSnapshot(), Date.now())) return;

  const response = await fetch('/api/garmin-sync', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`garmin-sync antwortete mit Status ${response.status}`);
  }
  writeLastSyncAt(new Date().toISOString());
}

/**
 * Returns the timestamp of this device's last *successful* sync, or `null` if it
 * has never had one. `null` deliberately shows no caption: a device that has never
 * synced has nothing to report yet, and the nightly cron may well have filled the
 * list already.
 */
export function useActivitySync(): string | null {
  const lastSyncAt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const attempt = () => {
      refreshIfStale().catch((error) => {
        console.error('[activities] sync failed', error);
      });
    };

    // No background timer (ADR-0009: iOS has no Periodic Background Sync) — the
    // interval only runs while the tab is actually visible.
    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(attempt, REFRESH_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    const onFocus = () => attempt();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        attempt();
        startInterval();
      } else {
        stopInterval();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    attempt();
    if (document.visibilityState === 'visible') startInterval();

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, []);

  return lastSyncAt;
}
