import {
  IconWeatherClear,
  IconWeatherCloudy,
  IconWeatherFog,
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

export const WEATHER_LABEL_BY_CATEGORY: Record<WeatherCategory, string> = {
  clear: 'Klar',
  'partly-cloudy': 'Teils bewölkt',
  cloudy: 'Bewölkt',
  fog: 'Nebel',
  rain: 'Regen',
  snow: 'Schnee',
  thunderstorm: 'Gewitter',
};
