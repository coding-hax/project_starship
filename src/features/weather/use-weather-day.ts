import type { WeatherLocation } from '@/features/settings/use-weather-location';
import type { WeatherDay } from '@/local/dexie';
import { findWeatherDay, nextWeatherDate } from './forecast';
import { useWeatherCache } from './use-weather-cache';

export type WeatherDayPhase = 'loading' | 'ready' | 'no-data';

export interface WeatherDayState {
  phase: WeatherDayPhase;
  day: WeatherDay | null;
  /** The day right after `day` in the cached forecast, or `null` at the last day
   * (issue #269 AC2) — same neighbour access `WeatherDayScreen` already reads off
   * `useWeatherCache` for swipe navigation (issue #267), just surfaced here too so
   * `WeatherDayDetail` doesn't need a second cache read of its own. */
  nextDay: WeatherDay | null;
}

/**
 * The single day `date` out of the cached forecast for `location` (issue #156).
 * Built on `useWeatherCache`, not `useWeatherForecast` — no refresh trigger, so
 * opening the day detail page never causes a fetch of its own; it only ever shows
 * whatever the overview strip's own refresh has already cached.
 *
 * `'no-data'` covers both "nothing cached yet" and "cached, but this date isn't
 * in the current 7-day window" — same explanatory state either way, since from
 * this page's point of view there's nothing to distinguish (AC "Datum ohne Daten").
 */
export function useWeatherDay(location: WeatherLocation, date: string): WeatherDayState {
  const cache = useWeatherCache(location);

  if (cache.phase === 'loading') return { phase: 'loading', day: null, nextDay: null };
  const day = cache.days ? findWeatherDay(cache.days, date) : undefined;
  if (!day) return { phase: 'no-data', day: null, nextDay: null };
  const nextDate = cache.days ? nextWeatherDate(cache.days, date) : null;
  const nextDay = (nextDate && cache.days ? findWeatherDay(cache.days, nextDate) : undefined) ?? null;
  return { phase: 'ready', day, nextDay };
}
