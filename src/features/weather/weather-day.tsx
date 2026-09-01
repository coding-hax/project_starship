'use client';

import Link from 'next/link';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useWeatherLocation } from '@/features/settings/use-weather-location';
import { PageFace } from '@/ui/faces';
import { SectionCard } from '@/ui/section-card';
import { IconChevronLeft, IconMoon, IconSunSimple } from '@/ui/icons';
import { useNow } from '@/ui/use-now';
import {
  berlinNowMark,
  formatDayHeading,
  hourLabel,
  nextWeatherDate,
  nightTemperature,
  previousWeatherDate,
  smoothPath,
  temperatureAtHour,
  temperatureAxis,
  windDirectionLabel,
} from './forecast';
import { useWeatherCache } from './use-weather-cache';
import { useWeatherDay } from './use-weather-day';
import { WEATHER_ICON_BY_CATEGORY, WEATHER_LABEL_BY_CATEGORY } from './weather-category-labels';
import { weatherCategory } from './wmo-icon';

/** Mirrors task-item.tsx's own swipe threshold (issue #267 AC4: "Schwelle analog
 * task-item.tsx") — below this, or when the vertical delta dominates, releasing
 * is a cancelled gesture and the page springs back instead of changing the day. */
const SWIPE_THRESHOLD_PX = 80;

/*
 * One geometry for both charts: same plot box, same hour grid, so the temperature
 * curve and the precipitation bars can be read against each other column for
 * column. User units, not pixels — the `viewBox` scales to whatever width the card
 * gives it. Since #939 removed the y-axis labels, the plot box spans the full
 * viewBox width (issue #998) — only the bottom row still holds the hour labels,
 * part of the same SVG rather than a separate flex row, because only inside the
 * SVG can a label sit at the exact x of the data point it belongs to. That
 * mismatch was an earlier bug: the label row once spread 00/06/12/18 evenly
 * across the full width, so "18:00" ended up at the right edge, where hour 23
 * actually is.
 */
const VIEW_W = 320;
const VIEW_H = 112;
const PLOT_Y = 6;
const PLOT_W = VIEW_W;
const PLOT_H = 80;
const PLOT_BOTTOM = PLOT_Y + PLOT_H;
const HOUR_LABEL_Y = PLOT_BOTTOM + 16;
const HOURS_PER_DAY = 24;
/** Every sixth hour of the day plus midnight at the far end — five evenly spaced
 * quarter-day marks, none of them crowding the last one (issue #795). */
const HOUR_TICKS = [0, 6, 12, 18, HOURS_PER_DAY];
/** Clearance a peak label needs above its point — a 100% precipitation bar or the
 * day's hottest hour would otherwise put a text line above PLOT_Y, outside the
 * viewBox (issue #998 AK8/AK16). */
const LABEL_HEADROOM = 12;

export interface WeatherDayDetailProps {
  date: string;
}

interface XTick {
  x: number;
  label: string;
}

/**
 * The axis frame both charts share: the baseline plus the hour labels — no
 * y-gridline or y-label (issue #939 AK4), the sheet reads the chart's shape
 * rather than its exact values. `children` are the data marks, drawn on top.
 */
function ChartFrame({
  className,
  ariaLabel,
  xTicks,
  children,
}: {
  className: string;
  ariaLabel: string;
  xTicks: XTick[];
  children: React.ReactNode;
}) {
  return (
    <svg className={className} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={ariaLabel}>
      <line className="weather-day__chart-axis" x1={0} x2={PLOT_W} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
      {xTicks.map((tick, i) => (
        <text
          key={tick.label}
          className="weather-day__chart-tick"
          x={tick.x}
          y={HOUR_LABEL_Y}
          // Centred on its tick, the first/last label would run past the viewBox
          // edge — so each anchors to its inside edge instead (issue #795 for the
          // last, issue #998 AK3 for the first).
          textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
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

/** Same reasoning as the hour ticks' own edge anchoring — a peak label centred
 * on hour 0 or the last hour would run past the viewBox edge (issue #998 AK16). */
function edgeAnchor(index: number, count: number): 'start' | 'middle' | 'end' {
  if (index === 0) return 'start';
  if (index === count - 1) return 'end';
  return 'middle';
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
  // Called unconditionally, ahead of the early returns below (rules of hooks) —
  // `phase` moves loading → ready without unmounting this component.
  const nowMark = berlinNowMark(useNow());

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
  const rainHours = day.hours.filter((hour) => hour.precipitation > 0);
  const rainTotal = rainHours.reduce((sum, hour) => sum + hour.precipitation, 0);
  const maxProbability = Math.max(0, ...day.hours.map((hour) => hour.precipitationProbability));
  // No rain at all (maxProbability 0, header reads "Kein Niederschlag erwartet.")
  // gets no peak label — a "0 %" line over an empty baseline (issue #998 AK7).
  // Earliest hour wins a tie (AK6): `findIndex` returns the first match.
  const peakProbabilityIndex =
    maxProbability > 0 ? day.hours.findIndex((hour) => hour.precipitationProbability === maxProbability) : -1;
  // Both charts scale into PLOT_H minus the label headroom rather than the full
  // plot height, so a 100% bar or the day's hottest hour still has room above it
  // for its own label (issue #998 AK8/AK12/AK16).
  const plotMaxHeight = PLOT_H - LABEL_HEADROOM;

  const axis = temperatureAxis(day.hours);
  const curveOffsetY = PLOT_Y + LABEL_HEADROOM;
  const curve = smoothPath(day.hours, PLOT_W, plotMaxHeight, axis);
  const temperatureY = (value: number) =>
    PLOT_BOTTOM - ((value - axis.min) / (axis.max - axis.min)) * plotMaxHeight;
  // Hour n reads the axis as a full day, 0..24 — so it sits at n/24 of the width,
  // one slot short of the right edge, matching the 24:00 tick there (issue #795).
  const curveX = (hour: number) => (hour / HOURS_PER_DAY) * PLOT_W;
  // A bar owns a slot instead, so its label belongs over that slot's centre.
  const slotWidth = PLOT_W / HOURS_PER_DAY;
  const barWidth = slotWidth * 0.6;
  const slotX = (hour: number) => (hour + 0.5) * slotWidth;

  const isToday = nowMark.dateKey === date;
  const nowTemp = isToday && day.hours.length > 0 ? temperatureAtHour(day.hours, nowMark.hourOfDay) : null;

  // The curve's own highest/lowest plotted point (day.hours), not day.tempMax/Min
  // — those daily aggregates can disagree with the hourly series, and a number
  // that doesn't match its own spot is worse than none (issue #998 AK13).
  const tempValues = day.hours.map((hour) => hour.temperature);
  const maxTemp = Math.max(...tempValues);
  const minTemp = Math.min(...tempValues);
  const maxTempIndex = day.hours.findIndex((hour) => hour.temperature === maxTemp);
  const minTempIndex = day.hours.findIndex((hour) => hour.temperature === minTemp);
  // A flat day collapses both extremes onto the same hour — one caption, not two
  // stacked on top of each other (AK14).
  const showMinTempLabel = minTemp !== maxTemp;
  // The now-point already carries this exact value at this exact spot — drawing
  // the extreme label on top of it would repeat the number (AK15).
  const maxTempCoincidesWithNow = nowTemp !== null && nowMark.hourOfDay === maxTempIndex;
  const minTempCoincidesWithNow = nowTemp !== null && nowMark.hourOfDay === minTempIndex;

  return (
    <div className="weather-day">
      <SectionCard
        title="Tagesverlauf"
        className="weather-day__card"
        headerAside={
          day.apparentTempMax !== undefined ? `Gefühlt ${Math.round(day.apparentTempMax)}°` : undefined
        }
      >
        <ChartFrame
          className="weather-day__chart"
          ariaLabel={`Temperaturverlauf von ${Math.round(day.tempMin)}° bis ${Math.round(day.tempMax)}°, stündlich`}
          xTicks={HOUR_TICKS.map((hour) => ({ x: curveX(hour), label: hourTickLabel(hour) }))}
        >
          <defs>
            <linearGradient id="weather-day-temp-area" x1="0" y1="0" x2="0" y2="1">
              <stop className="weather-day__area-stop--top" offset="0" />
              <stop className="weather-day__area-stop--bottom" offset="1" />
            </linearGradient>
          </defs>
          <path className="weather-day__chart-area" d={curve.area} transform={`translate(0 ${curveOffsetY})`} />
          <path className="weather-day__chart-line" d={curve.line} transform={`translate(0 ${curveOffsetY})`} />
          {nowTemp !== null && (
            <>
              <circle
                className="weather-day__now-dot"
                cx={curveX(nowMark.hourOfDay)}
                cy={temperatureY(nowTemp)}
                r={3.5}
              />
              <text
                className="weather-day__now-label"
                x={curveX(nowMark.hourOfDay)}
                y={temperatureY(nowTemp) - 8}
                textAnchor="middle"
              >
                {Math.round(nowTemp)}°
              </text>
            </>
          )}
          {!maxTempCoincidesWithNow && (
            <text
              className="weather-day__extreme-label"
              x={curveX(maxTempIndex)}
              y={temperatureY(maxTemp) - 8}
              textAnchor={edgeAnchor(maxTempIndex, day.hours.length)}
              aria-hidden="true"
            >
              {Math.round(maxTemp)}°
            </text>
          )}
          {showMinTempLabel && !minTempCoincidesWithNow && (
            <text
              className="weather-day__extreme-label"
              x={curveX(minTempIndex)}
              y={temperatureY(minTemp) - 8}
              textAnchor={edgeAnchor(minTempIndex, day.hours.length)}
              aria-hidden="true"
            >
              {Math.round(minTemp)}°
            </text>
          )}
        </ChartFrame>
        {day.hours.some((hour) => typeof hour.weatherCode === 'number') && (
          <ol className="weather-day__hourly" aria-label="Wetterlage je Stunde">
            {day.hours.map((hour) => {
              if (typeof hour.weatherCode !== 'number') return null;
              const hourCategory = weatherCategory(hour.weatherCode);
              const HourIcon = WEATHER_ICON_BY_CATEGORY[hourCategory];
              return (
                <li key={hour.time} className="weather-day__hourly-cell">
                  <span className="weather-day__hourly-time">{hourLabel(hour.time)}</span>
                  <span
                    className="weather-day__hourly-icon"
                    role="img"
                    aria-label={WEATHER_LABEL_BY_CATEGORY[hourCategory]}
                  >
                    <HourIcon />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>

      <SectionCard
        title="Niederschlag"
        className="weather-day__card"
        headerAside={
          <span className="weather-day__precipitation-total">
            {rainHours.length === 0 ? 'Kein Niederschlag erwartet.' : `Insgesamt ${rainTotal.toFixed(1)} mm`}
          </span>
        }
      >
        <ChartFrame
          className="weather-day__precipitation-chart"
          ariaLabel={`Regenwahrscheinlichkeit je Stunde, höchstens ${maxProbability} %`}
          // Ticks sit on the slot boundary (same position as curveX), not the slot
          // centre a bar itself is drawn at — both charts share one hour grid.
          xTicks={HOUR_TICKS.map((hour) => ({ x: curveX(hour), label: hourTickLabel(hour) }))}
        >
          {day.hours.map((hour, i) => {
            const height = (hour.precipitationProbability / 100) * plotMaxHeight;
            return (
              <rect
                key={hour.time}
                className="weather-day__precipitation-bar"
                x={slotX(i) - barWidth / 2}
                y={PLOT_BOTTOM - height}
                width={barWidth}
                height={height}
                rx={2}
              />
            );
          })}
          {peakProbabilityIndex !== -1 && (
            <text
              className="weather-day__precip-peak-label"
              x={slotX(peakProbabilityIndex)}
              y={PLOT_BOTTOM - (maxProbability / 100) * plotMaxHeight - 8}
              textAnchor="middle"
              aria-hidden="true"
            >
              {maxProbability} %
            </text>
          )}
        </ChartFrame>
      </SectionCard>

      <section
        className="weather-day__values"
        aria-label={`Wetter: ${WEATHER_LABEL_BY_CATEGORY[category]}`}
      >
        {/* Letzte Karte der Seite (issue #938 AK1) — Icon + Höchst-/Tiefstwert
            stehen seit issue #870 im Kopf, hier bleiben nur die vier Rohwerte. */}
        <dl className="weather-day__stats">
          <div className="weather-day__stat">
            <dt>Wind</dt>
            <dd>
              {Math.round(day.windSpeedMax)} km/h
              {day.windDirection !== undefined && (
                <span className="weather-day__wind-direction">{windDirectionLabel(day.windDirection)}</span>
              )}
            </dd>
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
    </div>
  );
}

export interface WeatherDayScreenProps {
  /** The date the server rendered this route for. Only read once, on mount —
   * every later day change stays entirely on the client (issue #267). */
  initialDate: string;
}

/**
 * The topbar (issue #233's focus fix) plus `WeatherDayDetail`, wrapped in the
 * swipe/keyboard day-switcher (issue #267). The current day lives in plain
 * React state, never a Next.js route param after the first paint: switching
 * days only ever calls `history.pushState` directly (kept in sync with
 * `usePathname` by Next's own patched pushState) rather than `router.push`,
 * which would ask the server to re-render the segment — exactly the "eigener
 * Netzaufruf" AC8 rules out, and the one thing that would break offline.
 */
export function WeatherDayScreen({ initialDate }: WeatherDayScreenProps) {
  const { location } = useWeatherLocation();
  const cache = useWeatherCache(location);
  const [currentDate, setCurrentDate] = useState(initialDate);
  const [startX, setStartX] = useState<number | null>(null);
  const [startY, setStartY] = useState<number | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bouncing, setBouncing] = useState(false);

  // Gleicher Store wie WeatherDayDetail (ADR-0009) — ein zweiter Live-Query
  // statt Prop-Drilling hält den Kopf automatisch synchron, wenn sich der
  // Cache ändert (issue #870 T3).
  const { phase: headPhase, day: headDay, nextDay: headNextDay } = useWeatherDay(
    location,
    currentDate,
  );
  const headCategory = headDay ? weatherCategory(headDay.weatherCode) : null;
  const HeadIcon = headCategory ? WEATHER_ICON_BY_CATEGORY[headCategory] : null;
  const headNight = headDay ? nightTemperature(headDay, headNextDay) : null;

  const nextDate = cache.days ? nextWeatherDate(cache.days, currentDate) : null;
  const previousDate = cache.days ? previousWeatherDate(cache.days, currentDate) : null;

  function switchTo(date: string) {
    window.history.pushState(null, '', `/wetter/${date}`);
    setCurrentDate(date);
  }

  // The browser back/forward buttons move the URL without going through
  // `switchTo` — this is what actually reacts to that (AC2).
  useEffect(() => {
    function onPopState() {
      const match = /^\/wetter\/([^/]+)$/.exec(window.location.pathname);
      if (match) setCurrentDate(match[1]);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Keyboard equivalent (AC6) — a pure gesture would leave desktop/keyboard use
  // with no way to switch days at all. Mirrors the gesture's own left/right
  // mapping: swipe left / ArrowLeft both advance to the next day.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.key === 'ArrowLeft' ? nextDate : previousDate;
      if (!target) return;
      event.preventDefault();
      switchTo(target);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nextDate, previousDate]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // The back link is its own control — capturing the pointer here would steal
    // the click the browser is about to synthesize for it (same reasoning as
    // task-item.tsx's own guard for its checkbox/button).
    if ((event.target as HTMLElement).closest('a')) return;
    setStartX(event.clientX);
    setStartY(event.clientY);
    setDragging(true);
    setBouncing(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || startX === null) return;
    setDragX(event.clientX - startX);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const deltaX = startX === null ? 0 : event.clientX - startX;
    const deltaY = startY === null ? 0 : event.clientY - startY;
    setDragging(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);

    // Too short, or mostly vertical (AC4) — both leave the day unchanged.
    const isSwipe = Math.abs(deltaX) > SWIPE_THRESHOLD_PX && Math.abs(deltaX) > Math.abs(deltaY);
    const target = isSwipe ? (deltaX < 0 ? nextDate : previousDate) : null;

    if (target) {
      // A real day change is instant, never a glide (AC7) — `dragX` above already
      // reset to 0 without ever turning `bouncing` on, so no transition plays.
      switchTo(target);
    } else {
      // Invalid swipe or the edge of the 7-day window (AC3) — spring back instead.
      setBouncing(true);
    }
  }

  /** The browser took the gesture over (e.g. a real vertical scroll) — nothing to
   * undo visually, same reasoning as task-item.tsx's own `cancelDrag`. */
  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setStartX(null);
    setStartY(null);
    setDragX(0);
  }

  return (
    <div
      className="weather-day-screen"
      data-ground="wetter"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
    >
      {/* Siehe page.tsx/issue #233: das <header> selbst ist der Fokus-Fix, ein
          <header> ist nicht fokussierbar, der App-Router-Aufruf verpufft.
          Drei Zonen (issue #870 T3): Augenbraue (immer, auch loading/no-data —
          Zurück muss erreichbar bleiben), Titel = Temperatur, Zusatz =
          Kategorie-Unterzeile (beide nur bei geladenen Daten). */}
      <header className="weather-day__topbar">
        <div className="weather-day__eyebrow-row">
          <Link href="/uebersicht" className="weather-day__back">
            <IconChevronLeft />
            Übersicht
          </Link>
          <p className="weather-day__date page-head__eyebrow">{formatDayHeading(currentDate)}</p>
        </div>
        {headPhase === 'ready' && headDay && headCategory && HeadIcon && (
          <>
            <div className="weather-day__title-cluster">
              <div className="weather-day__headline">
                <span
                  className="weather-day__icon"
                  role="img"
                  aria-label={WEATHER_LABEL_BY_CATEGORY[headCategory]}
                >
                  <HeadIcon />
                </span>
                <span className="weather-day__temps">
                  <h1
                    className="weather-day__temp-max"
                    aria-label={`Höchstwert: ${Math.round(headDay.tempMax)} Grad`}
                  >
                    <IconSunSimple />
                    {Math.round(headDay.tempMax)}°
                  </h1>
                  {/* Fehlt der Folgetag (letzter Tag der Vorhersage), ersetzt diese
                      sichtbare Beschriftung den Mond — eine leere Stelle sähe kaputt
                      aus (issue #269 AC3). aria-hidden, weil die Bedeutung schon im
                      aria-label des Nachbarelements steckt. */}
                  {!headNight && (
                    <span className="weather-day__temp-fallback-label" aria-hidden="true">
                      Tiefstwert
                    </span>
                  )}
                  <span
                    className="weather-day__temp-min"
                    aria-label={
                      headNight
                        ? `nachts, ${hourLabel(headNight.windowStart)} bis ${hourLabel(headNight.windowEnd)}: ${Math.round(headNight.value)} Grad`
                        : `Tiefstwert: ${Math.round(headDay.tempMin)} Grad`
                    }
                  >
                    {headNight && <IconMoon />}
                    {Math.round(headNight ? headNight.value : headDay.tempMin)}°
                  </span>
                </span>
              </div>
              <PageFace face="wetter" />
            </div>
            <p className="page-head__subline">{WEATHER_LABEL_BY_CATEGORY[headCategory]}</p>
          </>
        )}
      </header>
      <div
        className={
          'weather-day-screen__content' +
          (bouncing ? ' weather-day-screen__content--bouncing' : '')
        }
        style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
        onTransitionEnd={() => setBouncing(false)}
      >
        <WeatherDayDetail date={currentDate} />
      </div>
    </div>
  );
}
