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
import { formatStaleSince, isStaleWarning, isWeekend, weekdayLabel } from './forecast';
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

  // `loading` and `ready` share this exact grid shape, so the very first paint
  // already reserves the height the loaded state needs (Smooth-Regel 3). The
  // caption below is absolutely positioned and outside this flow entirely —
  // its own appearance can't shift anything, loading or not.
  return (
    <section className="weather-forecast" aria-label="Wettervorhersage Bonn, sieben Tage">
      <ol className="weather-forecast__days" aria-hidden={phase === 'loading' || undefined}>
        {phase === 'ready' && days
          ? days.map((day) => {
              const category = weatherCategory(day.weatherCode);
              const Icon = ICON_BY_CATEGORY[category];
              const weekend = isWeekend(day.date);
              return (
                <li
                  key={day.date}
                  className={
                    weekend
                      ? 'weather-forecast__day weather-forecast__day--weekend'
                      : 'weather-forecast__day'
                  }
                >
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
      {phase === 'ready' && fetchedAt && isStaleWarning(fetchedAt) ? (
        // Absolutely positioned (weather-forecast.css) so its appearance never shifts
        // the content below — the section's own height never includes it (issue #155).
        <p className="weather-forecast__caption">Stand: {formatStaleSince(fetchedAt)}</p>
      ) : null}
    </section>
  );
}
