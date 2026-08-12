'use client';

import Link from 'next/link';
import { useWeatherLocation } from '@/features/settings/use-weather-location';
import { formatStaleSince, isStaleWarning } from '@/ui/stale';
import { isWeekend, isWindy, weekdayLabel } from './forecast';
import { useWeatherForecast } from './use-weather-forecast';
import { WEATHER_ICON_BY_CATEGORY, WEATHER_LABEL_BY_CATEGORY } from './weather-category-labels';
import { weatherCategory } from './wmo-icon';

/**
 * The 7-day forecast for the configured location, at the very top of /uebersicht
 * (issue #139, #159). Reads only from the local cache via `useWeatherForecast` —
 * no `fetch` here, ADR-0009.
 */
export function WeatherForecast() {
  const { location } = useWeatherLocation();
  const { phase, days, fetchedAt } = useWeatherForecast(location);
  const ariaLabel = `Wettervorhersage ${location.name}, sieben Tage`;

  if (phase === 'empty-error') {
    return (
      <section className="weather-forecast" aria-label={ariaLabel}>
        <p className="weather-forecast__empty">Vorhersage konnte nicht geladen werden.</p>
      </section>
    );
  }

  // `loading` and `ready` share this exact grid shape, so the very first paint
  // already reserves the height the loaded state needs (Smooth-Regel 3). The
  // caption below is absolutely positioned and outside this flow entirely —
  // its own appearance can't shift anything, loading or not.
  return (
    <section className="weather-forecast" aria-label={ariaLabel}>
      <p className="weather-forecast__location">{location.name}</p>
      <ol className="weather-forecast__days" aria-hidden={phase === 'loading' || undefined}>
        {phase === 'ready' && days
          ? days.map((day) => {
              const category = weatherCategory(day.weatherCode);
              const Icon = WEATHER_ICON_BY_CATEGORY[category];
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
                  {/* Own page with the hourly breakdown (issue #156) — the whole
                      card is the tap target (≥44×44, DESIGN_SYSTEM Mobile-Patterns). */}
                  <Link href={`/wetter/${day.date}`} className="weather-forecast__day-link">
                    <span className="weather-forecast__weekday-row">
                      <span className="weather-forecast__weekday">{weekdayLabel(day.date)}</span>
                      {isWindy(day) ? (
                        <svg
                          className="weather-forecast__wind"
                          viewBox="0 0 16 16"
                          width="13"
                          height="13"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          role="img"
                          aria-label="windig"
                        >
                          <path d="M1.5 7h7a2 2 0 1 0-2-2" />
                          <path d="M1.5 11h5.5a2 2 0 1 1-2 2" />
                        </svg>
                      ) : null}
                    </span>
                    <span
                      className="weather-forecast__icon"
                      role="img"
                      aria-label={WEATHER_LABEL_BY_CATEGORY[category]}
                    >
                      <Icon />
                    </span>
                    <span className="weather-forecast__temps">
                      <span className="weather-forecast__temp-max">{Math.round(day.tempMax)}°</span>
                      <span className="weather-forecast__temp-min">{Math.round(day.tempMin)}°</span>
                    </span>
                  </Link>
                </li>
              );
            })
          : Array.from({ length: 7 }, (_, i) => (
              // Same markup and classes as a loaded column, values swapped for
              // placeholders — that, not a guessed pixel height, is what keeps this
              // row exactly as tall as the loaded one (Smooth-Regel 3).
              <li key={i} className="weather-forecast__day weather-forecast__day--skeleton">
                <span className="weather-forecast__day-link">
                  <span className="weather-forecast__weekday">&nbsp;</span>
                  <span className="weather-forecast__icon weather-forecast__icon--placeholder" />
                  <span className="weather-forecast__temps">
                    <span className="weather-forecast__temp-max">&nbsp;</span>
                    <span className="weather-forecast__temp-min">&nbsp;</span>
                  </span>
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
