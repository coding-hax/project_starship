import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db, type WeatherDay } from '@/local/dexie';
import { fetchForecast, isStale, REFRESH_INTERVAL_MS, WEATHER_CACHE_KEY } from './forecast';

export type WeatherPhase = 'loading' | 'ready' | 'empty-error';

export interface WeatherForecastState {
  phase: WeatherPhase;
  days: WeatherDay[] | null;
  fetchedAt: string | null;
}

/**
 * Fetches only when the cache is missing or older than `REFRESH_INTERVAL_MS`
 * (ADR-0009). A failure never touches the cache — the live query below keeps
 * showing whatever was there before.
 */
async function refreshIfStale(): Promise<void> {
  const cached = await db.weather.get(WEATHER_CACHE_KEY);
  if (cached && !isStale(cached.fetchedAt)) return;
  const days = await fetchForecast();
  await db.weather.put({ key: WEATHER_CACHE_KEY, fetchedAt: new Date().toISOString(), days });
}

/**
 * Reads the Bonn forecast straight from IndexedDB (CLAUDE.md rule 8) — never a
 * `fetch` in the render path. `phase` starts at `'loading'` while the very first
 * IndexedDB read is in flight; once it resolves to nothing cached, it stays
 * `'loading'` until the first refresh attempt settles, then becomes `'ready'`
 * (a cache row exists — refresh failures afterwards don't change that, AC5) or
 * `'empty-error'` (still nothing, and the refresh failed too).
 */
export function useWeatherForecast(): WeatherForecastState {
  const [entry, setEntry] = useState<{ days: WeatherDay[]; fetchedAt: string } | null | undefined>(
    undefined,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);

  useEffect(() => {
    const subscription = liveQuery(() => db.weather.get(WEATHER_CACHE_KEY)).subscribe({
      next: (record) => setEntry(record ?? null),
      error: (error) => console.error('[weather] live query failed', error),
    });
    return () => subscription.unsubscribe();
  }, []);

  // `refreshIfStale` itself decides whether a fetch actually happens — every
  // trigger here just asks "is the cache old enough?" (issue #155). No trigger
  // ever forces a network call on its own, so firing several at once (e.g. focus
  // right after visibilitychange) costs at most one real fetch.
  useEffect(() => {
    let cancelled = false;
    const attempt = () => {
      refreshIfStale()
        .then(() => {
          if (!cancelled) setRefreshFailed(false);
        })
        .catch((error) => {
          console.error('[weather] refresh failed', error);
          if (!cancelled) setRefreshFailed(true);
        });
    };

    // No background timer (ADR-0009, iOS has no Periodic Background Sync) — the
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
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, []);

  if (entry === undefined) return { phase: 'loading', days: null, fetchedAt: null };
  if (entry === null) {
    return refreshFailed
      ? { phase: 'empty-error', days: null, fetchedAt: null }
      : { phase: 'loading', days: null, fetchedAt: null };
  }
  return { phase: 'ready', days: entry.days, fetchedAt: entry.fetchedAt };
}
