/**
 * Client-driven pull for `.ics` subscriptions (issue #560, ADR-0022) — same
 * shape as the weather module (`use-weather-cache.ts`/`use-weather-forecast.ts`):
 * a live-query read side that never fetches on its own, and a refresh side
 * whose triggers only ever ask "is this cache old enough?". No server cron
 * (ADR-0009): each device pulls for itself, straight into its own IndexedDB.
 */

import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { fetchIcsText } from '@/local/ics-fetch';
import { db, type IcsSubscriptionEntry } from '@/local/dexie';
import { ICS_REFRESH_INTERVAL_MS, expandIcsEvents, icsHorizon, isIcsStale } from './ics-expand';
import { parseIcs } from './ics-parse';
import type { EventView } from './use-events';

/**
 * Refreshes every subscription whose cache is missing or stale. A failed
 * fetch only ever touches `lastError` — `events` keeps showing whatever was
 * cached before (same reasoning as `refreshIfStale` in the weather module).
 */
export async function refreshStaleSubscriptions(): Promise<void> {
  const subscriptions = await db.icsSubscriptions.toArray();
  const horizon = icsHorizon();

  await Promise.all(
    subscriptions
      .filter((subscription) => isIcsStale(subscription.fetchedAt))
      .map(async (subscription) => {
        try {
          const text = await fetchIcsText(subscription.url);
          const events = expandIcsEvents(parseIcs(text), horizon);
          await db.icsSubscriptions.put({
            ...subscription,
            events,
            fetchedAt: new Date().toISOString(),
            lastError: null,
          });
        } catch (error) {
          await db.icsSubscriptions.put({
            ...subscription,
            lastError: error instanceof Error ? error.message : 'Unbekannter Fehler.',
          });
        }
      }),
  );
}

function toSubscribedEventView(subscription: IcsSubscriptionEntry): EventView[] {
  return subscription.events.map((event) => ({
    id: `${subscription.id}:${event.uid}:${event.startDate}`,
    title: event.title,
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: event.startDate,
    endDate: event.endDate,
    category: null,
    recurrence: null,
    origin: 'subscribed',
  }));
}

/** Read-only live view of every subscribed calendar's already-expanded events — no fetch side effects, mirrors `useWeatherCache`. */
export function useSubscribedEvents(): EventView[] {
  const [subscriptions, setSubscriptions] = useState<IcsSubscriptionEntry[]>([]);

  useEffect(() => {
    const subscription = liveQuery(() => db.icsSubscriptions.toArray()).subscribe({
      next: setSubscriptions,
      error: (error) => console.error('[ics] live query failed', error),
    });
    return () => subscription.unsubscribe();
  }, []);

  return subscriptions.flatMap(toSubscribedEventView);
}

/**
 * Fires `refreshStaleSubscriptions` on mount/focus/visibility, same trigger
 * set as `useWeatherForecast` (issue #155) — no background timer, since iOS
 * has no Periodic Background Sync (ADR-0009).
 */
export function useIcsSubscriptionsRefresh(): void {
  useEffect(() => {
    const attempt = () => {
      refreshStaleSubscriptions().catch((error) => console.error('[ics] refresh failed', error));
    };

    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(attempt, ICS_REFRESH_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    const onFocus = () => attempt();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        attempt();
        startInterval();
      } else {
        stopInterval();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    attempt();
    if (document.visibilityState === 'visible') startInterval();

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, []);
}
