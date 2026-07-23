import type { WeatherDay } from '@/local/dexie';

export type { WeatherDay };

/** Bonn, hard-wired (issue #139) — single-user app, no location prompt. */
const LATITUDE = 50.7374;
const LONGITUDE = 7.0982;

const FORECAST_URL =
  `https://api.open-meteo.com/v1/forecast` +
  `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
  `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
  `&timezone=Europe%2FBerlin&forecast_days=7`;

/** One cache row per this key — the location never varies, so there is only ever one. */
export const WEATHER_CACHE_KEY = 'bonn';

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
export async function fetchForecast(): Promise<WeatherDay[]> {
  const response = await fetch(FORECAST_URL);
  if (!response.ok) {
    throw new Error(`Open-Meteo antwortete mit Status ${response.status}`);
  }
  return parseForecast(await response.json());
}

const WEEKDAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']; // Date#getDay(): 0 = Sunday

/** German weekday abbreviation for a `YYYY-MM-DD` date key, local calendar day. */
export function weekdayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
}

/** The visible age hint (AC4: offline shows the last known forecast with its age). */
export function formatAge(fetchedAt: string, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - new Date(fetchedAt).getTime());
  if (diffMs < 60_000) return 'gerade eben';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `vor ${minutes} Min.`;
  return `vor ${Math.round(minutes / 60)} Std.`;
}
