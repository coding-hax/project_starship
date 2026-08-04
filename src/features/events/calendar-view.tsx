'use client';

import { useState } from 'react';
import { berlinNow } from '@/push/schedule';
import { EventTimeline } from './event-timeline';
import { useEvents } from './use-events';
import { WeekStrip } from './week-strip';

/**
 * `/kalender` (issue #553, S2 of #473): a day timeline behind a collapsed week
 * strip. `selectedDay` is a Berlin calendar day, not the device's local one —
 * the same reference `berlinNow` already gives the reminder scheduler
 * (src/push/schedule.ts), so there is only ever one "today" in this app.
 */
export function CalendarView() {
  const events = useEvents();
  const today = berlinNow(new Date()).dateKey;
  const [selectedDay, setSelectedDay] = useState(today);

  return (
    <div className="calendar-view">
      {/* <header> is the auto-focus target after navigation (CODEMAP invariant,
          same reasoning as weather-day.tsx) — WeekStrip's paging controls live
          in it, not just a bare heading. */}
      <header className="calendar-view__header">
        <h1>Kalender</h1>
        <WeekStrip selectedDay={selectedDay} onSelectDay={setSelectedDay} today={today} />
      </header>
      <EventTimeline events={events ?? []} selectedDay={selectedDay} today={today} />
    </div>
  );
}
