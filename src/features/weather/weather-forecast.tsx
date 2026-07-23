'use client';

import {
  IconWeatherClear,
  IconWeatherCloudy,
  IconWeatherFog,
  IconWeatherPartlyCloudy,
  IconWeatherRain,
  IconWeatherSnow,
  IconWeatherThunderstorm,
} from '@/ui/icons';
import { formatAge, weekdayLabel } from './forecast';
import { useWeatherForecast } from './use-weather-forecast';
import type { WeatherCategory } from './wmo-icon';
import { weatherCategory } from './wmo-icon';

const ICON_BY_CATEGORY = {
  clear: IconWeatherClear,
  'partly-cloudy': IconWeatherPartlyCloudy,
  cloudy: IconWeatherCloudy,
  fog: IconWeatherFog,
  rain: IconWeatherRain,
  snow: IconWeatherSnow,
  thunderstorm: IconWeatherThunderstorm,
};

const LABEL_BY_CATEGORY: Record<WeatherCategory, string> = {
  clear: 'Klar',
  'partly-cloudy': 'Teils bewölkt',
  cloudy: 'Bewölkt',
  fog: 'Nebel',
  rain: 'Regen',
  snow: 'Schnee',
  thunderstorm: 'Gewitter',
};

/**
 * The 7-day Bonn forecast, at the very top of /heute (issue #139). Reads only
 * from the local cache via `useWeatherForecast` — no `fetch` here, ADR-0009.
 */
export function WeatherForecast() {
  const { phase, days, fetchedAt } = useWeatherForecast();

  if (phase === 'empty-error') {
    return (
      <section className="weather-forecast" aria-label="Wettervorhersage Bonn, sieben Tage">
        <p className="weather-forecast__empty">Vorhersage konnte nicht geladen werden.</p>
      </section>
    );
  }

  // `loading` and `ready` share this exact shape — including the caption row below
  // — so the very first paint already reserves the height the loaded state needs
  // and nothing shifts once the cache (or the network) answers (Smooth-Regel 3).
  return (
    <section className="weather-forecast" aria-label="Wettervorhersage Bonn, sieben Tage">
      <ol className="weather-forecast__days" aria-hidden={phase === 'loading' || undefined}>
        {phase === 'ready' && days
          ? days.map((day) => {
              const category = weatherCategory(day.weatherCode);
              const Icon = ICON_BY_CATEGORY[category];
              return (
                <li key={day.date} className="weather-forecast__day">
                  <span className="weather-forecast__weekday">{weekdayLabel(day.date)}</span>
                  <span
                    className="weather-forecast__icon"
                    role="img"
                    aria-label={LABEL_BY_CATEGORY[category]}
                  >
                    <Icon />
                  </span>
                  <span className="weather-forecast__temps">
                    <span className="weather-forecast__temp-max">{Math.round(day.tempMax)}°</span>
                    <span className="weather-forecast__temp-min">{Math.round(day.tempMin)}°</span>
                  </span>
                </li>
              );
            })
          : Array.from({ length: 7 }, (_, i) => (
              // Same markup and classes as a loaded column, values swapped for
              // placeholders — that, not a guessed pixel height, is what keeps this
              // row exactly as tall as the loaded one (Smooth-Regel 3).
              <li key={i} className="weather-forecast__day weather-forecast__day--skeleton">
                <span className="weather-forecast__weekday">&nbsp;</span>
                <span className="weather-forecast__icon weather-forecast__icon--placeholder" />
                <span className="weather-forecast__temps">
                  <span className="weather-forecast__temp-max">&nbsp;</span>
                  <span className="weather-forecast__temp-min">&nbsp;</span>
                </span>
              </li>
            ))}
      </ol>
      <p className="weather-forecast__caption" style={phase === 'loading' ? { visibility: 'hidden' } : undefined}>
        {phase === 'ready' && fetchedAt
          ? `Wetter: Open-Meteo · aktualisiert ${formatAge(fetchedAt)}`
          : ' '}
      </p>
    </section>
  );
}
