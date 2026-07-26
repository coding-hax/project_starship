import type { WeatherLocation } from '@/features/settings/use-weather-location';
import type { WeatherDay } from '@/local/dexie';
import { findWeatherDay } from './forecast';
import { useWeatherCache } from './use-weather-cache';

export type WeatherDayPhase = 'loading' | 'ready' | 'no-data';

export interface WeatherDayState {
  phase: WeatherDayPhase;
  day: WeatherDay | null;
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

  if (cache.phase === 'loading') return { phase: 'loading', day: null };
  const day = cache.days ? findWeatherDay(cache.days, date) : undefined;
  return day ? { phase: 'ready', day } : { phase: 'no-data', day: null };
}
