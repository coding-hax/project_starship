import {
  IconMoon,
  IconWeatherClear,
  IconWeatherCloudy,
  IconWeatherFog,
  IconWeatherMoonCloudy,
  IconWeatherPartlyCloudy,
  IconWeatherRain,
  IconWeatherSnow,
  IconWeatherThunderstorm,
} from '@/ui/icons';
import type { WeatherCategory } from './wmo-icon';

/**
 * Icon + German label per category (issue #139) — shared between the 7-day strip
 * (weather-forecast.tsx) and the day detail page (weather-day.tsx, issue #156) so
 * the two never drift apart.
 */
export const WEATHER_ICON_BY_CATEGORY = {
  clear: IconWeatherClear,
  'partly-cloudy': IconWeatherPartlyCloudy,
  cloudy: IconWeatherCloudy,
  fog: IconWeatherFog,
  rain: IconWeatherRain,
  snow: IconWeatherSnow,
  thunderstorm: IconWeatherThunderstorm,
};

/**
 * Night-only icon swap for the day-detail band (issue #999 AK7) — only `clear`
 * and `partly-cloudy` carry a sun in their glyph to begin with, so only those two
 * have a night variant; rain/snow/thunderstorm/fog/cloudy fall through to
 * `WEATHER_ICON_BY_CATEGORY` unchanged. Only `weather-day.tsx`'s band reads this
 * map — the 7-day strip (`weather-forecast.tsx`) has no notion of night and keeps
 * importing `WEATHER_ICON_BY_CATEGORY` alone (AK12).
 */
export const WEATHER_NIGHT_ICON_BY_CATEGORY: Partial<Record<WeatherCategory, typeof IconMoon>> = {
  clear: IconMoon,
  'partly-cloudy': IconWeatherMoonCloudy,
};

export const WEATHER_LABEL_BY_CATEGORY: Record<WeatherCategory, string> = {
  clear: 'Klar',
  'partly-cloudy': 'Teils bewölkt',
  cloudy: 'Bewölkt',
  fog: 'Nebel',
  rain: 'Regen',
  snow: 'Schnee',
  thunderstorm: 'Gewitter',
};
