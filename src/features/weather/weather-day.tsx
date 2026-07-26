'use client';

import type { CSSProperties } from 'react';
import { useWeatherLocation } from '@/features/settings/use-weather-location';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import { hourLabel, temperatureLinePoints } from './forecast';
import { useWeatherDay } from './use-weather-day';
import { WEATHER_ICON_BY_CATEGORY, WEATHER_LABEL_BY_CATEGORY } from './weather-category-labels';
import { weatherCategory } from './wmo-icon';

const CHART_WIDTH = 280;
const CHART_HEIGHT = 100;
// Every 6th hour of a 24-entry array (0, 6, 12, 18) — enough to read the curve's
// shape without crowding the axis.
const CHART_LABEL_HOURS = [0, 6, 12, 18];

export interface WeatherDayDetailProps {
  date: string;
}

/**
 * Hourly breakdown for one day out of the cached forecast (issue #156). Reads only
 * from IndexedDB via `useWeatherDay` — no `fetch` here, same ADR-0009 rule as
 * `WeatherForecast`, and no *own* refresh trigger either (AC "kein eigener
 * Netzaufruf"): whatever the overview strip has cached is all this page ever shows.
 */
export function WeatherDayDetail({ date }: WeatherDayDetailProps) {
  const { location } = useWeatherLocation();
  const { phase, day } = useWeatherDay(location, date);

  if (phase === 'loading') {
    return (
      <section className="weather-day weather-day--loading" aria-label="Wetterdetails werden geladen">
        <div className="weather-day__skeleton" />
      </section>
    );
  }

  if (phase === 'no-data' || !day) {
    return (
      <section className="weather-day">
        <p className="weather-day__empty">Für diesen Tag liegen keine Wetterdaten vor.</p>
      </section>
    );
  }

  const category = weatherCategory(day.weatherCode);
  const Icon = WEATHER_ICON_BY_CATEGORY[category];
  const rainHours = day.hours.filter((hour) => hour.precipitation > 0);
  const points = temperatureLinePoints(day.hours, CHART_WIDTH, CHART_HEIGHT);

  return (
    <div className="weather-day">
      <section
        className="weather-day__summary"
        aria-label={`Wetter: ${WEATHER_LABEL_BY_CATEGORY[category]}`}
      >
        <span className="weather-day__icon" role="img" aria-label={WEATHER_LABEL_BY_CATEGORY[category]}>
          <Icon />
        </span>
        <span className="weather-day__temps">
          <span className="weather-day__temp-max">{Math.round(day.tempMax)}°</span>
          <span className="weather-day__temp-min">{Math.round(day.tempMin)}°</span>
        </span>
      </section>

      <SectionCard title="Tagesverlauf">
        <svg
          className="weather-day__chart"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`Temperaturverlauf von ${Math.round(day.tempMin)}° bis ${Math.round(day.tempMax)}°, stündlich`}
        >
          <polyline points={points} className="weather-day__chart-line" />
        </svg>
        <div className="weather-day__chart-labels">
          {CHART_LABEL_HOURS.map((h) => (
            <span key={h}>{String(h).padStart(2, '0')}:00</span>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Niederschlag">
        <p className="weather-day__precipitation-summary">
          {rainHours.length === 0
            ? 'Kein Niederschlag erwartet.'
            : `Insgesamt ${rainHours.reduce((sum, hour) => sum + hour.precipitation, 0).toFixed(1)} mm`}
        </p>
        <ol className="weather-day__precipitation-bars">
          {day.hours.map((hour) => (
            <li
              key={hour.time}
              className="weather-day__precipitation-bar"
              style={{ '--bar-height': `${hour.precipitationProbability}%` } as CSSProperties}
              aria-label={`${hourLabel(hour.time)} Uhr: ${hour.precipitationProbability}% Regenwahrscheinlichkeit`}
            />
          ))}
        </ol>
        {rainHours.length > 0 && (
          <ul className="weather-day__precipitation-hours">
            {rainHours.map((hour) => (
              <li key={hour.time}>
                {`${hourLabel(hour.time)} · ${hour.precipitation.toFixed(1)} mm (${hour.precipitationProbability}%)`}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Wind">
        <Row label="Geschwindigkeit">{Math.round(day.windSpeedMax)} km/h</Row>
        <Row label="Böen bis">{Math.round(day.windGustsMax)} km/h</Row>
      </SectionCard>

      <SectionCard title="Sonne">
        <Row label="Aufgang">{hourLabel(day.sunrise)}</Row>
        <Row label="Untergang">{hourLabel(day.sunset)}</Row>
      </SectionCard>
    </div>
  );
}
