/**
 * Pure timeline-layout logic (issue #553, S2 of #473) — no DB, no DOM, so it's
 * Vitest-testable like habits/due-today.ts and schedule-rules.ts. Only scheduled
 * (`allDay: false`) events are handled here; the all-day band is S4 (#555).
 */

import { berlinNow } from '@/push/schedule';
import type { EventView } from './use-events';

const MINUTES_PER_DAY = 1440;

/** Berlin-local minutes since midnight for an ISO instant — thin wrapper, no new TZ logic. */
export function berlinMinutesOfDay(instant: string): number {
  return berlinNow(new Date(instant)).minutesOfDay;
}

function berlinDateKey(instant: string): string {
  return berlinNow(new Date(instant)).dateKey;
}

export interface TimelineEvent extends Omit<EventView, 'startsAt' | 'endsAt'> {
  /** Narrowed from `EventView` — `layoutForDay` only ever keeps scheduled events. */
  startsAt: string;
  endsAt: string;
  /** Top offset as a percentage of the 0–24h axis (`minutesOfDay / 1440 * 100`). */
  topPct: number;
  /** Card height as a percentage of the axis, floored so the tap target stays reachable. */
  heightPct: number;
}

/**
 * `--touch-target` (44px, tokens.css) against the 1440px-tall day axis that
 * `event-timeline.css` builds from `--hour-height: 60px` × 24 — that sizing makes
 * 1 minute == 1 px, so the same fraction that positions a card in percent also
 * floors its height at a tappable size.
 */
const MIN_HEIGHT_PCT = (44 / MINUTES_PER_DAY) * 100;

/**
 * Visible, scheduled events on `dayKey` (a Berlin calendar day, `YYYY-MM-DD`),
 * positioned on a 0–24h axis. All-day events and events with no `startsAt`/
 * `endsAt` are filtered out. An event that starts before `dayKey` or ends after
 * it is clamped to the day's own bounds (0 / 1440 minutes) — a real over-midnight
 * split into two cards is S4, not built here.
 */
export function layoutForDay(events: EventView[], dayKey: string): TimelineEvent[] {
  return events
    .filter(
      (event): event is EventView & { startsAt: string; endsAt: string } =>
        !event.allDay && event.startsAt !== null && event.endsAt !== null,
    )
    .filter((event) => berlinDateKey(event.startsAt) === dayKey || berlinDateKey(event.endsAt) === dayKey)
    .map((event) => {
      const startMinutes =
        berlinDateKey(event.startsAt) === dayKey ? berlinMinutesOfDay(event.startsAt) : 0;
      const endMinutes =
        berlinDateKey(event.endsAt) === dayKey ? berlinMinutesOfDay(event.endsAt) : MINUTES_PER_DAY;
      const topPct = (startMinutes / MINUTES_PER_DAY) * 100;
      const heightPct = Math.max(((endMinutes - startMinutes) / MINUTES_PER_DAY) * 100, MIN_HEIGHT_PCT);
      return { ...event, topPct, heightPct };
    });
}

/** Now-line position as a percentage of the same 0–24h axis `layoutForDay` uses. */
export function nowLinePct(now: Date): number {
  return (berlinNow(now).minutesOfDay / MINUTES_PER_DAY) * 100;
}

/** The card's left edge colour — the single place this category → token mapping lives. */
export function categoryEdgeVar(category: EventView['category']): string {
  return category ? `var(--cat-${category})` : 'var(--area-events)';
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `dateKey` shifted by `delta` days — pure string arithmetic via a UTC-anchored
 * `Date` (never the device's local timezone, unlike due-today.ts's `weekDays`),
 * so paging the timeline day-by-day is independent of the machine it runs on.
 */
export function addDays(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatDateKey(date);
}

/** The Mon–Sun date keys of the week containing `dateKey`, Monday first. */
export function weekDaysFor(dateKey: string): string[] {
  const date = parseDateKey(dateKey);
  const weekday = date.getUTCDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  return Array.from({ length: 7 }, (_, offset) => addDays(dateKey, diffToMonday + offset));
}
