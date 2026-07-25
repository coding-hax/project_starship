import type { WeatherDay } from '@/local/dexie';

export type { WeatherDay };

/** The location is chosen in Einstellungen (issue #159, use-weather-location.ts) —
 * this module only ever sees coordinates, no fixed place. */
function buildForecastUrl(latitude: number, longitude: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Europe%2FBerlin&forecast_days=7`
  );
}

/**
 * One cache row per location — switching location switches the key (issue #159), so a
 * refresh still in flight for the previous place can never land under the new one's
 * name; it just writes to a key nothing reads anymore.
 */
export function weatherCacheKey(latitude: number, longitude: number): string {
  return `${latitude},${longitude}`;
}

/** The ICON model's compute cadence (issue #139) — a refresh sooner would return the same numbers. */
export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** `fetchedAt` older than this counts as stale and is due for a background refresh. */
export function isStale(fetchedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(fetchedAt).getTime() >= REFRESH_INTERVAL_MS;
}

interface OpenMeteoForecastResponse {
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

/** Open-Meteo's column-oriented `daily` block, one row per day — kept separate from
 * the network call so the shape can be tested without a fetch mock. */
export function parseForecast(response: OpenMeteoForecastResponse): WeatherDay[] {
  const { daily } = response;
  return daily.time.map((date, i) => ({
    date,
    weatherCode: daily.weather_code[i],
    tempMax: daily.temperature_2m_max[i],
    tempMin: daily.temperature_2m_min[i],
    precipitationProbability: daily.precipitation_probability_max[i],
  }));
}

/** Throws on a network error or a non-2xx response — the caller decides what that means for the cache. */
export async function fetchForecast(latitude: number, longitude: number): Promise<WeatherDay[]> {
  const response = await fetch(buildForecastUrl(latitude, longitude));
  if (!response.ok) {
    throw new Error(`Open-Meteo antwortete mit Status ${response.status}`);
  }
  return parseForecast(await response.json());
}

const WEEKDAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']; // Date#getDay(): 0 = Sunday

function localWeekday(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
}

/** German weekday abbreviation for a `YYYY-MM-DD` date key, local calendar day. */
export function weekdayLabel(dateKey: string): string {
  return WEEKDAY_LABELS[localWeekday(dateKey)];
}

/** Saturday or Sunday, local calendar day (issue #155: stronger column border). */
export function isWeekend(dateKey: string): boolean {
  const day = localWeekday(dateKey);
  return day === 0 || day === 6;
}

/**
 * Two failed refresh attempts' worth of the 3h `REFRESH_INTERVAL_MS` — past this,
 * the caption becomes a real warning instead of routine housekeeping (issue #155).
 */
const STALE_WARNING_THRESHOLD_MS = 8 * 60 * 60 * 1000;

export function isStaleWarning(fetchedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - new Date(fetchedAt).getTime() >= STALE_WARNING_THRESHOLD_MS;
}

/** `HH:MM`, 24-hour, local time (VISION) — the last successful fetch (issue #155). */
export function formatStaleSince(fetchedAt: string): string {
  const date = new Date(fetchedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
