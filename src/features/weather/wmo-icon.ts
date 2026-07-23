/**
 * Open-Meteo's `daily.weather_code` is the WMO's ~28-value weather interpretation
 * code. The UI draws one of seven icons (icons.tsx), so this maps the wide code
 * space down to that small, testable set — kept out of the component per issue #139.
 */
export type WeatherCategory =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'thunderstorm';

const CATEGORY_BY_CODE: Record<number, WeatherCategory> = {
  0: 'clear',
  1: 'partly-cloudy',
  2: 'partly-cloudy',
  3: 'cloudy',
  45: 'fog',
  48: 'fog',
  51: 'rain',
  53: 'rain',
  55: 'rain',
  56: 'rain',
  57: 'rain',
  61: 'rain',
  63: 'rain',
  65: 'rain',
  66: 'rain',
  67: 'rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  80: 'rain',
  81: 'rain',
  82: 'rain',
  85: 'snow',
  86: 'snow',
  95: 'thunderstorm',
  96: 'thunderstorm',
  99: 'thunderstorm',
};

/**
 * A code outside the known table (a future WMO revision, a malformed response)
 * falls back to `'cloudy'` — the least specific claim the icon set has, rather
 * than guessing sun or rain for something unrecognized.
 */
export function weatherCategory(code: number): WeatherCategory {
  return CATEGORY_BY_CODE[code] ?? 'cloudy';
}
