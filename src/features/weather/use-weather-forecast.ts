import { useEffect, useState } from 'react';
import type { WeatherLocation } from '@/features/settings/use-weather-location';
import { db, type WeatherDay } from '@/local/dexie';
import { fetchForecast, isStale, REFRESH_INTERVAL_MS, weatherCacheKey } from './forecast';
import { useWeatherCache } from './use-weather-cache';

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
async function refreshIfStale(location: WeatherLocation, cacheKey: string): Promise<void> {
  const cached = await db.weather.get(cacheKey);
  if (cached && !isStale(cached.fetchedAt)) return;
  const days = await fetchForecast(location.latitude, location.longitude);
  await db.weather.put({ key: cacheKey, fetchedAt: new Date().toISOString(), days });
}

/**
 * Reads the forecast for `location` straight from IndexedDB (CLAUDE.md rule 8) — never a
 * `fetch` in the render path. `phase` starts at `'loading'` while the very first
 * IndexedDB read is in flight; once it resolves to nothing cached, it stays
 * `'loading'` until the first refresh attempt settles, then becomes `'ready'`
 * (a cache row exists — refresh failures afterwards don't change that, AC5) or
 * `'empty-error'` (still nothing, and the refresh failed too).
 */
export function useWeatherForecast(location: WeatherLocation): WeatherForecastState {
  const cacheKey = weatherCacheKey(location.latitude, location.longitude);
  const cache = useWeatherCache(location);
  const [refreshFailed, setRefreshFailed] = useState(false);

  // A location change swaps the cache key entirely (issue #159 AC3) — reset
  // synchronously during render (React's "adjusting state when a prop changes"
  // pattern), same reasoning `useWeatherCache` applies to its own `entry` state.
  const [cacheKeyForRefreshFailed, setCacheKeyForRefreshFailed] = useState(cacheKey);
  if (cacheKeyForRefreshFailed !== cacheKey) {
    setCacheKeyForRefreshFailed(cacheKey);
    setRefreshFailed(false);
  }

  // `refreshIfStale` itself decides whether a fetch actually happens — every
  // trigger here just asks "is the cache old enough?" (issue #155). No trigger
  // ever forces a network call on its own, so firing several at once (e.g. focus
  // right after visibilitychange) costs at most one real fetch.
  useEffect(() => {
    let cancelled = false;
    const attempt = () => {
      refreshIfStale(location, cacheKey)
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
  }, [cacheKey, location]);

  if (cache.phase === 'loading') return { phase: 'loading', days: null, fetchedAt: null };
  if (cache.phase === 'empty') {
    return refreshFailed
      ? { phase: 'empty-error', days: null, fetchedAt: null }
      : { phase: 'loading', days: null, fetchedAt: null };
  }
  return { phase: 'ready', days: cache.days, fetchedAt: cache.fetchedAt };
}
