import { describe, expect, it } from 'vitest';
import {
  addDays,
  allDayEventsForDay,
  berlinMinutesOfDay,
  categoryEdgeVar,
  formatCountdown,
  layoutForDay,
  nowLinePct,
  upcomingEventsToday,
  weekDaysFor,
} from './event-time';
import type { EventView } from './use-events';

function iso(utc: number): string {
  return new Date(utc).toISOString();
}

function event(overrides: Partial<EventView>): EventView {
  return {
    id: 'evt-1',
    title: 'Termin',
    allDay: false,
    startsAt: null,
    endsAt: null,
    startDate: null,
    endDate: null,
    category: null,
    recurrence: null,
    ...overrides,
  };
}

describe('berlinMinutesOfDay', () => {
  it('reports 09:00 Berlin (540 minutes) on a summer instant (CEST, UTC+2)', () => {
    // 07:00 UTC in July is 09:00 Berlin.
    expect(berlinMinutesOfDay(iso(Date.UTC(2026, 6, 18, 7, 0)))).toBe(9 * 60);
  });

  it('reports 09:00 Berlin (540 minutes) on a winter instant (CET, UTC+1)', () => {
    // 08:00 UTC in January is 09:00 Berlin.
    expect(berlinMinutesOfDay(iso(Date.UTC(2026, 0, 15, 8, 0)))).toBe(9 * 60);
  });
});

describe('layoutForDay', () => {
  const DAY = '2026-07-18'; // CEST, Berlin = UTC+2

  it('places a same-day event at its Berlin start/end minute', () => {
    const events = [
      event({
        // 09:00-10:00 Berlin.
        startsAt: iso(Date.UTC(2026, 6, 18, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 8, 0)),
      }),
    ];

    const [layout] = layoutForDay(events, DAY);

    expect(layout.topPct).toBeCloseTo((9 * 60 * 100) / 1440);
    expect(layout.heightPct).toBeCloseTo((60 * 100) / 1440);
  });

  it('filters out all-day events', () => {
    const events = [event({ allDay: true, startDate: DAY, endDate: DAY, startsAt: null, endsAt: null })];

    expect(layoutForDay(events, DAY)).toEqual([]);
  });

  it('filters out an event that never touches the requested day', () => {
    const events = [
      event({
        startsAt: iso(Date.UTC(2026, 6, 15, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 15, 8, 0)),
      }),
    ];

    expect(layoutForDay(events, DAY)).toEqual([]);
  });

  it('clamps an event that starts the previous day to the day\'s top edge', () => {
    const events = [
      event({
        // 23:30 Berlin the day before -> 00:30 Berlin on DAY.
        startsAt: iso(Date.UTC(2026, 6, 17, 21, 30)),
        endsAt: iso(Date.UTC(2026, 6, 17, 22, 30)),
      }),
    ];

    const [layout] = layoutForDay(events, DAY);

    expect(layout.topPct).toBe(0);
  });

  it('clamps an event that ends the next day to the day\'s bottom edge', () => {
    const events = [
      event({
        // 22:00 Berlin on DAY -> 00:30 Berlin the next day (2.5h, well above the tap-target floor).
        startsAt: iso(Date.UTC(2026, 6, 18, 20, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 22, 30)),
      }),
    ];

    const [layout] = layoutForDay(events, DAY);

    expect(layout.topPct + layout.heightPct).toBeCloseTo(100);
  });

  it('floors the height of a very short event to the tap-target minimum', () => {
    const events = [
      event({
        // 09:00-09:05 Berlin — 5 minutes, far under the 44-minute floor.
        startsAt: iso(Date.UTC(2026, 6, 18, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 7, 5)),
      }),
    ];

    const [layout] = layoutForDay(events, DAY);

    expect(layout.heightPct).toBeCloseTo((44 * 100) / 1440);
  });
});

describe('nowLinePct', () => {
  it('sits near the bottom of the axis just before midnight (23:59 Berlin)', () => {
    const pct = nowLinePct(new Date(iso(Date.UTC(2026, 6, 18, 21, 59))));

    expect(pct).toBeCloseTo((1439 * 100) / 1440);
  });

  it('sits near the top of the axis just after midnight (00:01 Berlin)', () => {
    const pct = nowLinePct(new Date(iso(Date.UTC(2026, 6, 18, 22, 1))));

    expect(pct).toBeCloseTo(100 / 1440);
  });
});

describe('addDays', () => {
  it('advances a date key by one day', () => {
    expect(addDays('2026-07-18', 1)).toBe('2026-07-19');
  });

  it('rolls back across a month boundary', () => {
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('rolls forward across a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('weekDaysFor', () => {
  it('returns the Mon-Sun week containing a midweek date, Monday first', () => {
    // 2026-07-18 is a Saturday.
    expect(weekDaysFor('2026-07-18')).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
    ]);
  });

  it('treats a Sunday as the last day of its own week, not the first of the next', () => {
    // 2026-07-19 is a Sunday.
    expect(weekDaysFor('2026-07-19')).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
    ]);
  });
});

describe('allDayEventsForDay', () => {
  it('places a single-day all-day event on its own day, not continuing either side', () => {
    const events = [event({ allDay: true, startDate: '2026-07-18', endDate: '2026-07-18' })];

    const [item] = allDayEventsForDay(events, '2026-07-18');

    expect(item.continuesBefore).toBe(false);
    expect(item.continuesAfter).toBe(false);
  });

  it('shows a 3-day event on each of its three days, flagged as continuing on the middle/edge days', () => {
    const events = [event({ allDay: true, startDate: '2026-07-18', endDate: '2026-07-20' })];

    const first = allDayEventsForDay(events, '2026-07-18')[0];
    const middle = allDayEventsForDay(events, '2026-07-19')[0];
    const last = allDayEventsForDay(events, '2026-07-20')[0];

    expect(first.continuesBefore).toBe(false);
    expect(first.continuesAfter).toBe(true);
    expect(middle.continuesBefore).toBe(true);
    expect(middle.continuesAfter).toBe(true);
    expect(last.continuesBefore).toBe(true);
    expect(last.continuesAfter).toBe(false);
  });

  it('stays correct across a month boundary', () => {
    const events = [event({ allDay: true, startDate: '2026-07-30', endDate: '2026-08-02' })];

    expect(allDayEventsForDay(events, '2026-07-31')).toHaveLength(1);
    expect(allDayEventsForDay(events, '2026-08-01')[0].continuesBefore).toBe(true);
    expect(allDayEventsForDay(events, '2026-08-02')[0].continuesAfter).toBe(false);
  });

  it('excludes a day outside the event range', () => {
    const events = [event({ allDay: true, startDate: '2026-07-18', endDate: '2026-07-19' })];

    expect(allDayEventsForDay(events, '2026-07-20')).toEqual([]);
  });

  it('filters out scheduled (non-all-day) events', () => {
    const events = [
      event({
        allDay: false,
        startsAt: iso(Date.UTC(2026, 6, 18, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 8, 0)),
      }),
    ];

    expect(allDayEventsForDay(events, '2026-07-18')).toEqual([]);
  });
});

describe('categoryEdgeVar', () => {
  it('maps a category to its own token', () => {
    expect(categoryEdgeVar('arbeit')).toBe('var(--cat-arbeit)');
  });

  it('falls back to the area colour when there is no category', () => {
    expect(categoryEdgeVar(null)).toBe('var(--area-events)');
  });
});

describe('upcomingEventsToday', () => {
  // 12:00 UTC on 2026-07-18 = 14:00 Berlin (CEST).
  const NOW = new Date(iso(Date.UTC(2026, 6, 18, 12, 0)));

  it('orders today\'s remaining events by start time', () => {
    const later = event({
      title: 'Später',
      startsAt: iso(Date.UTC(2026, 6, 18, 15, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 16, 0)),
    });
    const next = event({
      title: 'Als Nächstes',
      startsAt: iso(Date.UTC(2026, 6, 18, 13, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 14, 0)),
    });

    expect(upcomingEventsToday([later, next], NOW).map((e) => e.title)).toEqual([
      'Als Nächstes',
      'Später',
    ]);
  });

  it('keeps an event that has already started but not yet ended', () => {
    const inProgress = event({
      startsAt: iso(Date.UTC(2026, 6, 18, 11, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 13, 0)),
    });

    expect(upcomingEventsToday([inProgress], NOW)).toHaveLength(1);
  });

  it('drops an event that has already ended', () => {
    const past = event({
      startsAt: iso(Date.UTC(2026, 6, 18, 9, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 10, 0)),
    });

    expect(upcomingEventsToday([past], NOW)).toEqual([]);
  });

  it('drops an event on a different day', () => {
    const tomorrow = event({
      startsAt: iso(Date.UTC(2026, 6, 19, 9, 0)),
      endsAt: iso(Date.UTC(2026, 6, 19, 10, 0)),
    });

    expect(upcomingEventsToday([tomorrow], NOW)).toEqual([]);
  });

  it('drops all-day events', () => {
    const allDay = event({ allDay: true, startDate: '2026-07-18', endDate: '2026-07-18' });

    expect(upcomingEventsToday([allDay], NOW)).toEqual([]);
  });
});

describe('formatCountdown', () => {
  const NOW = new Date(iso(Date.UTC(2026, 6, 18, 12, 0)));

  it('reports whole minutes under an hour', () => {
    expect(formatCountdown(NOW, iso(Date.UTC(2026, 6, 18, 12, 40)))).toBe('in 40 Min');
  });

  it('reports hours and minutes over an hour', () => {
    expect(formatCountdown(NOW, iso(Date.UTC(2026, 6, 18, 14, 5)))).toBe('in 2 Std 5 Min');
  });

  it('omits minutes on an exact hour boundary', () => {
    expect(formatCountdown(NOW, iso(Date.UTC(2026, 6, 18, 14, 0)))).toBe('in 2 Std');
  });

  it('reads "Jetzt" once the event has started', () => {
    expect(formatCountdown(NOW, iso(Date.UTC(2026, 6, 18, 11, 0)))).toBe('Jetzt');
  });
});
