import type { WeatherDay, WeatherHour } from '@/local/dexie';

export type { WeatherDay, WeatherHour };

/** The location is chosen in Einstellungen (issue #159, use-weather-location.ts) —
 * this module only ever sees coordinates, no fixed place.
 *
 * `hourly` rides along on the same call as `daily` (issue #156) — the day detail
 * page reads the result out of the same cache row, never a second endpoint. */
function buildForecastUrl(latitude: number, longitude: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,wind_gusts_10m_max,apparent_temperature_max,wind_direction_10m_dominant` +
    `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code` +
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
    sunrise: string[];
    sunset: string[];
    wind_speed_10m_max: number[];
    wind_gusts_10m_max: number[];
    /** issue #927 — absent on responses cached before this field existed. */
    apparent_temperature_max?: number[];
    wind_direction_10m_dominant?: number[];
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    /** issue #927 — absent on responses cached before this field existed. */
    weather_code?: number[];
  };
}

/** Open-Meteo's column-oriented `daily`+`hourly` blocks, one row per day with its
 * 24 hours nested inside (issue #156) — kept separate from the network call so the
 * shape can be tested without a fetch mock. Bucketing by `date.startsWith` works
 * because both blocks come back in the same `Europe/Berlin` local-time shape
 * (`YYYY-MM-DDTHH:mm`), requested via the same `timezone` param. */
export function parseForecast(response: OpenMeteoForecastResponse): WeatherDay[] {
  const { daily, hourly } = response;
  const hours: WeatherHour[] = hourly.time.map((time, i) => ({
    time,
    temperature: hourly.temperature_2m[i],
    precipitationProbability: hourly.precipitation_probability[i],
    precipitation: hourly.precipitation[i],
    weatherCode: hourly.weather_code?.[i],
  }));
  return daily.time.map((date, i) => ({
    date,
    weatherCode: daily.weather_code[i],
    tempMax: daily.temperature_2m_max[i],
    tempMin: daily.temperature_2m_min[i],
    precipitationProbability: daily.precipitation_probability_max[i],
    sunrise: daily.sunrise[i],
    sunset: daily.sunset[i],
    windSpeedMax: daily.wind_speed_10m_max[i],
    windGustsMax: daily.wind_gusts_10m_max[i],
    apparentTempMax: daily.apparent_temperature_max?.[i],
    windDirection: daily.wind_direction_10m_dominant?.[i],
    hours: hours.filter((hour) => hour.time.startsWith(date)),
  }));
}

/** The one `WeatherDay` matching `date` out of a cached forecast, if the current
 * 7-day window still covers it (issue #156). */
export function findWeatherDay(days: WeatherDay[], date: string): WeatherDay | undefined {
  return days.find((day) => day.date === date);
}

/** The day right after `date` in the cached forecast, or `null` at the last day
 * (or if `date` itself isn't in `days`) — a plain index lookup works because
 * `daily.time` always comes back date-ascending (issue #267 swipe navigation). */
export function nextWeatherDate(days: WeatherDay[], date: string): string | null {
  const index = days.findIndex((day) => day.date === date);
  if (index === -1) return null;
  return days[index + 1]?.date ?? null;
}

/** Same as `nextWeatherDate`, the other direction (issue #267). */
export function previousWeatherDate(days: WeatherDay[], date: string): string | null {
  const index = days.findIndex((day) => day.date === date);
  if (index === -1) return null;
  return days[index - 1]?.date ?? null;
}

export interface NightTemperature {
  value: number;
  /** Local ISO instant the window opens at — `day.sunset` (issue #269). */
  windowStart: string;
  /** Local ISO instant the window closes at — `nextDay.sunrise`. */
  windowEnd: string;
}

/**
 * The minimum hourly temperature between `day`'s sunset and `nextDay`'s sunrise
 * (issue #269) — the *coming* night, not Open-Meteo's `temperature_2m_min`, which
 * is a midnight-to-midnight calendar-day minimum and so mostly falls in the night
 * that just ended rather than the one ahead. `null` when there is no next day
 * (last day of the 7-day window) or its hours don't reach far enough to cover any
 * part of the window — the caller falls back to the calendar-day minimum then
 * (AC3). String comparison on the `HH:MM`-suffixed local ISO instants is safe
 * here: both `day.hours` and `nextDay.hours` already carry no UTC offset (same
 * `Europe/Berlin` request timezone as everywhere else in this module).
 */
export function nightTemperature(day: WeatherDay, nextDay: WeatherDay | null): NightTemperature | null {
  if (!nextDay) return null;
  const windowStart = day.sunset;
  const windowEnd = nextDay.sunrise;
  const hours = [...day.hours, ...nextDay.hours].filter(
    (hour) => hour.time >= windowStart && hour.time <= windowEnd,
  );
  if (hours.length === 0) return null;
  return { value: Math.min(...hours.map((hour) => hour.temperature)), windowStart, windowEnd };
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

/** Bft 7 — the threshold the DWD warns of "Windböen" at (issue #695). Gusts decide
 * how a day *feels*: 25 km/h average with 60 km/h gusts reads windier than a steady 32. */
export const WINDY_GUST_THRESHOLD_KMH = 50;

/** Bft 5 — the steadily brisk day without individual spikes (issue #695). Its own
 * condition, or that day never trips the gust threshold above and falls through. */
export const WINDY_SPEED_THRESHOLD_KMH = 30;

/** Marks a day windy in the 7-day strip (issue #695) — gusts OR average wind past
 * their threshold, each catching a different kind of windy day (see the constants). */
export function isWindy(day: Pick<WeatherDay, 'windGustsMax' | 'windSpeedMax'>): boolean {
  return day.windGustsMax >= WINDY_GUST_THRESHOLD_KMH || day.windSpeedMax >= WINDY_SPEED_THRESHOLD_KMH;
}

const COMPASS_LABELS = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];

/** Degrees (`daily.wind_direction_10m_dominant`) to an 8-point compass label
 * (issue #927) — normalizes first so a negative or >360 degree value still
 * lands on a valid octant. */
export function windDirectionLabel(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return COMPASS_LABELS[index];
}


/**
 * `HH:MM` straight out of a local ISO instant (`WeatherHour.time`, `sunrise`,
 * `sunset` — issue #156). A plain slice, not `new Date(...).getHours()`: these
 * strings already carry no offset (`Europe/Berlin`, via the `timezone` request
 * param), so parsing them through `Date` would reinterpret them in whatever
 * timezone the reading device happens to be in instead.
 */
export function hourLabel(time: string): string {
  return time.slice(11, 16);
}

const DAY_HEADING_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** "Montag, 20. Juli" for a `YYYY-MM-DD` date key, local calendar day (issue #156,
 * the day detail page's heading). */
export function formatDayHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return DAY_HEADING_FORMATTER.format(new Date(year, month - 1, day));
}

export interface TemperatureAxis {
  min: number;
  max: number;
  /** Whole degrees, bottom to top — one label and one gridline each. */
  ticks: number[];
}

/**
 * The y-range of the temperature chart, snapped to whole degrees, plus the tick
 * values to label it with. Split out from `temperatureLinePoints` so both can be
 * fed the *same* range: a "15°" label has to sit exactly on the gridline the curve
 * touches, which it does not if the curve scales to the raw min/max while the
 * labels show rounded numbers.
 */
export function temperatureAxis(hours: WeatherHour[], tickCount = 3): TemperatureAxis {
  if (hours.length === 0) return { min: 0, max: 1, ticks: [] };
  const temps = hours.map((hour) => hour.temperature);
  const min = Math.floor(Math.min(...temps));
  // A day at a constant temperature would collapse the range to zero; one degree
  // of headroom keeps the flat curve on a readable line instead of on the frame.
  const max = Math.max(Math.ceil(Math.max(...temps)), min + 1);
  const step = (max - min) / Math.max(tickCount - 1, 1);
  const ticks = Array.from({ length: tickCount }, (_, i) => Math.round(min + i * step));
  return { min, max, ticks: [...new Set(ticks)] };
}

/**
 * SVG `points` for a 24-hour temperature curve (issue #156), scaled into a
 * `width`×`height` box — kept out of the component so the scaling math is
 * unit-testable without rendering, same reasoning as `weekdayLabel`/`isWeekend`
 * (issue #139). Without `domain` the day's own min/max span the box; the chart
 * passes `temperatureAxis`'s whole-degree range so curve and labels agree. Each
 * hour owns a slot of the box rather than spanning edge to edge — hour 23 lands
 * one slot short of the right edge, matching the axis reading the day as 0..24
 * (issue #795), not 0..23.
 */
export function temperatureLinePoints(
  hours: WeatherHour[],
  width: number,
  height: number,
  domain?: { min: number; max: number },
): string {
  if (hours.length === 0) return '';
  const temps = hours.map((hour) => hour.temperature);
  const min = domain ? domain.min : Math.min(...temps);
  const max = domain ? domain.max : Math.max(...temps);
  const range = max - min || 1;
  const stepX = width / hours.length;
  return hours
    .map((hour, i) => {
      const x = i * stepX;
      const y = height - ((hour.temperature - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
