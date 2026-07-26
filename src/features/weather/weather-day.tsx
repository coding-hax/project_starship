'use client';

import { useWeatherLocation } from '@/features/settings/use-weather-location';
import { SectionCard } from '@/ui/section-card';
import { hourLabel, temperatureAxis, temperatureLinePoints } from './forecast';
import { useWeatherDay } from './use-weather-day';
import { WEATHER_ICON_BY_CATEGORY, WEATHER_LABEL_BY_CATEGORY } from './weather-category-labels';
import { weatherCategory } from './wmo-icon';

/*
 * One geometry for both charts: same plot box, same hour grid, so the temperature
 * curve and the precipitation bars can be read against each other column for
 * column. User units, not pixels — the `viewBox` scales to whatever width the card
 * gives it. The left gutter holds the y labels, the bottom one the hours; both are
 * part of the same SVG rather than a separate flex row, because only inside the
 * SVG can a label sit at the exact x of the data point it belongs to. That
 * mismatch was the bug: the old label row spread 00/06/12/18 evenly across the
 * full width, so "18:00" ended up at the right edge, where hour 23 actually is.
 */
const VIEW_W = 320;
const VIEW_H = 132;
const PLOT_X = 38;
const PLOT_Y = 6;
const PLOT_W = VIEW_W - PLOT_X - 8;
const PLOT_H = 100;
const PLOT_BOTTOM = PLOT_Y + PLOT_H;
const HOUR_LABEL_Y = PLOT_BOTTOM + 16;
const HOURS_PER_DAY = 24;
const LAST_HOUR = HOURS_PER_DAY - 1;
/** Every sixth hour plus the last one — enough to read the shape without crowding. */
const HOUR_TICKS = [0, 6, 12, 18, LAST_HOUR];
const PRECIPITATION_TICKS = [0, 50, 100];

export interface WeatherDayDetailProps {
  date: string;
}

interface YTick {
  y: number;
  label: string;
}

interface XTick {
  x: number;
  label: string;
}

/**
 * The axis frame both charts share: a gridline plus label per y tick, the baseline,
 * and the hour labels. `children` are the data marks, drawn on top of it.
 */
function ChartFrame({
  className,
  ariaLabel,
  yTicks,
  xTicks,
  children,
}: {
  className: string;
  ariaLabel: string;
  yTicks: YTick[];
  xTicks: XTick[];
  children: React.ReactNode;
}) {
  return (
    <svg className={className} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={ariaLabel}>
      {yTicks.map((tick) => (
        <g key={tick.label}>
          <line
            className="weather-day__chart-grid"
            x1={PLOT_X}
            x2={PLOT_X + PLOT_W}
            y1={tick.y}
            y2={tick.y}
          />
          <text
            className="weather-day__chart-tick"
            x={PLOT_X - 6}
            y={tick.y}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {tick.label}
          </text>
        </g>
      ))}
      <line
        className="weather-day__chart-axis"
        x1={PLOT_X}
        x2={PLOT_X + PLOT_W}
        y1={PLOT_BOTTOM}
        y2={PLOT_BOTTOM}
      />
      {xTicks.map((tick, i) => (
        <text
          key={tick.label}
          className="weather-day__chart-tick"
          x={tick.x}
          y={HOUR_LABEL_Y}
          // Centred on its tick, the last label would run past the viewBox edge.
          textAnchor={i === xTicks.length - 1 ? 'end' : 'middle'}
        >
          {tick.label}
        </text>
      ))}
      {children}
    </svg>
  );
}

function hourTickLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
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
  const rainTotal = rainHours.reduce((sum, hour) => sum + hour.precipitation, 0);
  const maxProbability = Math.max(0, ...day.hours.map((hour) => hour.precipitationProbability));

  const axis = temperatureAxis(day.hours);
  const points = temperatureLinePoints(day.hours, PLOT_W, PLOT_H, axis);
  const temperatureY = (value: number) =>
    PLOT_BOTTOM - ((value - axis.min) / (axis.max - axis.min)) * PLOT_H;
  // The curve's endpoints sit on the frame's edges, so hour n is at n/23 of the width.
  const curveX = (hour: number) => PLOT_X + (hour / LAST_HOUR) * PLOT_W;
  // A bar owns a slot instead, so its label belongs over that slot's centre.
  const slotWidth = PLOT_W / HOURS_PER_DAY;
  const barWidth = slotWidth * 0.6;
  const slotX = (hour: number) => PLOT_X + (hour + 0.5) * slotWidth;

  return (
    <div className="weather-day">
      <section
        className="weather-day__summary"
        aria-label={`Wetter: ${WEATHER_LABEL_BY_CATEGORY[category]}`}
      >
        <div className="weather-day__headline">
          <span
            className="weather-day__icon"
            role="img"
            aria-label={WEATHER_LABEL_BY_CATEGORY[category]}
          >
            <Icon />
          </span>
          <span className="weather-day__temps">
            <span className="weather-day__temp-max">{Math.round(day.tempMax)}°</span>
            <span className="weather-day__temp-min">{Math.round(day.tempMin)}°</span>
          </span>
        </div>
        {/* Wind and sun are four single numbers — a compact strip right under the
            headline reads faster than two more cards at the bottom of the page. */}
        <dl className="weather-day__stats">
          <div className="weather-day__stat">
            <dt>Wind</dt>
            <dd>{Math.round(day.windSpeedMax)} km/h</dd>
          </div>
          <div className="weather-day__stat">
            <dt>Böen</dt>
            <dd>{Math.round(day.windGustsMax)} km/h</dd>
          </div>
          <div className="weather-day__stat">
            <dt>Aufgang</dt>
            <dd>{hourLabel(day.sunrise)}</dd>
          </div>
          <div className="weather-day__stat">
            <dt>Untergang</dt>
            <dd>{hourLabel(day.sunset)}</dd>
          </div>
        </dl>
      </section>

      <SectionCard title="Tagesverlauf">
        <ChartFrame
          className="weather-day__chart"
          ariaLabel={`Temperaturverlauf von ${Math.round(day.tempMin)}° bis ${Math.round(day.tempMax)}°, stündlich`}
          yTicks={axis.ticks.map((value) => ({ y: temperatureY(value), label: `${value}°` }))}
          xTicks={HOUR_TICKS.map((hour) => ({ x: curveX(hour), label: hourTickLabel(hour) }))}
        >
          <polyline
            points={points}
            className="weather-day__chart-line"
            transform={`translate(${PLOT_X} ${PLOT_Y})`}
          />
        </ChartFrame>
      </SectionCard>

      <SectionCard title="Niederschlag">
        <p className="weather-day__precipitation-summary">
          {rainHours.length === 0 ? 'Kein Niederschlag erwartet.' : `Insgesamt ${rainTotal.toFixed(1)} mm`}
        </p>
        <ChartFrame
          className="weather-day__precipitation-chart"
          ariaLabel={`Regenwahrscheinlichkeit je Stunde, höchstens ${maxProbability} %`}
          yTicks={PRECIPITATION_TICKS.map((value) => ({
            y: PLOT_BOTTOM - (value / 100) * PLOT_H,
            label: `${value} %`,
          }))}
          xTicks={HOUR_TICKS.map((hour) => ({ x: slotX(hour), label: hourTickLabel(hour) }))}
        >
          {day.hours.map((hour, i) => {
            const height = (hour.precipitationProbability / 100) * PLOT_H;
            return (
              <rect
                key={hour.time}
                className="weather-day__precipitation-bar"
                x={slotX(i) - barWidth / 2}
                y={PLOT_BOTTOM - height}
                width={barWidth}
                height={height}
              />
            );
          })}
        </ChartFrame>
      </SectionCard>
    </div>
  );
}
