'use client';

import { useState } from 'react';
import { berlinNow } from '@/push/schedule';
import { CalendarStrip } from './calendar-strip';
import { EventTimeline } from './event-timeline';
import { useEvents } from './use-events';

/**
 * `/kalender` (issue #553 S2, #556 S5 of #473): a day timeline behind a week
 * strip that pulls open into the full month. `selectedDay` is a Berlin
 * calendar day, not the device's local one — the same reference `berlinNow`
 * already gives the reminder scheduler (src/push/schedule.ts), so there is
 * only ever one "today" in this app.
 */
export function CalendarView() {
  const events = useEvents();
  const today = berlinNow(new Date()).dateKey;
  const [selectedDay, setSelectedDay] = useState(today);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="calendar-view">
      {/* <header> is the auto-focus target after navigation (CODEMAP invariant,
          same reasoning as weather-day.tsx) — CalendarStrip's paging controls
          live in it, not just a bare heading. */}
      <header className="calendar-view__header">
        <h1>Kalender</h1>
        <CalendarStrip
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          today={today}
          events={events ?? []}
          expanded={expanded}
          onExpandChange={setExpanded}
        />
      </header>
      <EventTimeline events={events ?? []} selectedDay={selectedDay} today={today} />
    </div>
  );
}
