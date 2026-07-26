import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import type { WeatherLocation } from '@/features/settings/use-weather-location';
import { db, type WeatherDay } from '@/local/dexie';
import { weatherCacheKey } from './forecast';

export type WeatherCachePhase = 'loading' | 'ready' | 'empty';

export interface WeatherCacheState {
  phase: WeatherCachePhase;
  days: WeatherDay[] | null;
  fetchedAt: string | null;
}

/**
 * Read-only live view of the cached forecast for `location` (issue #156) — no
 * refresh side effects, so mounting this alone never triggers a fetch.
 * `useWeatherForecast` layers the stale-refresh trigger on top for the overview
 * strip; the day detail page uses this directly, since opening it must not cause
 * a network call of its own (AC "kein eigener Netzaufruf").
 */
export function useWeatherCache(location: WeatherLocation): WeatherCacheState {
  const cacheKey = weatherCacheKey(location.latitude, location.longitude);

  const [entry, setEntry] = useState<{ days: WeatherDay[]; fetchedAt: string } | null | undefined>(
    undefined,
  );

  // A location change swaps the cache key entirely (issue #159 AC3) — reset the
  // entry synchronously during render so the previous location's forecast never
  // paints, not even for a single frame, under the new location's name.
  const [cacheKeyForEntry, setCacheKeyForEntry] = useState(cacheKey);
  if (cacheKeyForEntry !== cacheKey) {
    setCacheKeyForEntry(cacheKey);
    setEntry(undefined);
  }

  useEffect(() => {
    const subscription = liveQuery(() => db.weather.get(cacheKey)).subscribe({
      next: (record) => setEntry(record ?? null),
      error: (error) => console.error('[weather] live query failed', error),
    });
    return () => subscription.unsubscribe();
  }, [cacheKey]);

  if (entry === undefined) return { phase: 'loading', days: null, fetchedAt: null };
  if (entry === null) return { phase: 'empty', days: null, fetchedAt: null };
  return { phase: 'ready', days: entry.days, fetchedAt: entry.fetchedAt };
}
