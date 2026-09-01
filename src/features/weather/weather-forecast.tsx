'use client';

import Link from 'next/link';
import { useWeatherLocation } from '@/features/settings/use-weather-location';
import { OverviewBlock } from '@/ui/overview-block';
import { formatStaleSince, isStaleWarning } from '@/ui/stale';
import { isWeekend, isWindy, weekdayLabel } from './forecast';
import { useWeatherForecast } from './use-weather-forecast';
import { WEATHER_ICON_BY_CATEGORY, WEATHER_LABEL_BY_CATEGORY } from './weather-category-labels';
import { weatherCategory } from './wmo-icon';

/**
 * The 7-day forecast for the configured location, at the very top of /uebersicht
 * (issue #139, #159). Reads only from the local cache via `useWeatherForecast` —
 * no `fetch` here, ADR-0009. The sheet shows no visible title and no location
 * line here — a slim card, seven columns, nothing else (issue #973 AK1/AK2) —
 * so the module `<h2>` stays visually hidden (issue #972 AK3); the `aria-label`
 * on the `<section>` is where the location still lives on this page, more
 * specific than the generic "Wetter" heading above it.
 */
export function WeatherForecast() {
  const { location } = useWeatherLocation();
  const { phase, days, fetchedAt } = useWeatherForecast(location);
  const ariaLabel = `Wettervorhersage ${location.name}, sieben Tage`;

  // `loading`, `ready` and `empty-error` all render this same seven-column grid
  // shape, so the very first paint already reserves the height every other phase
  // needs (Smooth-Regel 3). `empty-error` keeps the (invisible) placeholder
  // columns in the DOM and overlays the message on top of them instead of
  // replacing them with a shorter box — that way it inherits their real height
  // for free instead of a hand-picked pixel guess that can silently drift out of
  // sync with it (issue #652 AC1). The stale-data caption stays absolutely
  // positioned and outside this flow entirely — its own appearance can't shift
  // anything either.
  return (
    <OverviewBlock hiddenTitle="Wetter">
      <section className="weather-forecast" aria-label={ariaLabel}>
        <ol className="weather-forecast__days" aria-hidden={phase !== 'ready' || undefined}>
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
                // row exactly as tall as the loaded one (Smooth-Regel 3). In
                // `empty-error` the columns turn invisible (`--error`, CSS) rather
                // than disappear — the overlaid message below inherits their height.
                <li
                  key={i}
                  className={
                    phase === 'empty-error'
                      ? 'weather-forecast__day weather-forecast__day--error'
                      : 'weather-forecast__day weather-forecast__day--skeleton'
                  }
                >
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
        {phase === 'empty-error' ? (
          <p className="weather-forecast__empty">Vorhersage konnte nicht geladen werden.</p>
        ) : null}
        {phase === 'ready' && fetchedAt && isStaleWarning(fetchedAt) ? (
          // Absolutely positioned (weather-forecast.css) so its appearance never shifts
          // the content below — the section's own height never includes it (issue #155).
          <p className="weather-forecast__caption">Stand: {formatStaleSince(fetchedAt)}</p>
        ) : null}
      </section>
    </OverviewBlock>
  );
}
