import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addMonthsClamped,
  agendaForDay,
  allDayEventsForDay,
  allDayRangeLabel,
  berlinMinutesOfDay,
  categoriesForDay,
  categoryEdgeVar,
  dateKeyDiff,
  dayWindow,
  formatCountdown,
  formatDuration,
  formatMonthTitle,
  monthDaysFor,
  monthEventCounts,
  monthName,
  nextInAgenda,
  upcomingEventsToday,
  weekDaysFor,
  weekWindow,
  yearLabel,
} from './event-time';
import { expandForDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
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
    origin: 'local',
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

describe('agendaForDay', () => {
  const DAY = '2026-07-18'; // CEST, Berlin = UTC+2

  it('keeps a same-day event', () => {
    const events = [
      event({
        // 09:00-10:00 Berlin.
        startsAt: iso(Date.UTC(2026, 6, 18, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 8, 0)),
      }),
    ];

    const [item] = agendaForDay(events, DAY);

    expect(item.startsAt).toBe(events[0].startsAt);
    expect(item.endsAt).toBe(events[0].endsAt);
  });

  it('filters out all-day events', () => {
    const events = [event({ allDay: true, startDate: DAY, endDate: DAY, startsAt: null, endsAt: null })];

    expect(agendaForDay(events, DAY)).toEqual([]);
  });

  it('filters out an event that never touches the requested day', () => {
    const events = [
      event({
        startsAt: iso(Date.UTC(2026, 6, 15, 7, 0)),
        endsAt: iso(Date.UTC(2026, 6, 15, 8, 0)),
      }),
    ];

    expect(agendaForDay(events, DAY)).toEqual([]);
  });

  it('includes an event that starts the previous day and ends on the requested day', () => {
    const events = [
      event({
        // 23:30 Berlin the day before -> 00:30 Berlin on DAY.
        startsAt: iso(Date.UTC(2026, 6, 17, 21, 30)),
        endsAt: iso(Date.UTC(2026, 6, 17, 22, 30)),
      }),
    ];

    expect(agendaForDay(events, DAY)).toHaveLength(1);
  });

  it('sorts chronologically regardless of input order', () => {
    const later = event({
      id: 'evt-later',
      startsAt: iso(Date.UTC(2026, 6, 18, 13, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 14, 0)),
    });
    const earlier = event({
      id: 'evt-earlier',
      startsAt: iso(Date.UTC(2026, 6, 18, 7, 0)),
      endsAt: iso(Date.UTC(2026, 6, 18, 8, 0)),
    });

    expect(agendaForDay([later, earlier], DAY).map((item) => item.id)).toEqual(['evt-earlier', 'evt-later']);
  });

  it('flags two events whose intervals overlap', () => {
    const events = [
      event({
        id: 'evt-a',
        startsAt: iso(Date.UTC(2026, 6, 18, 9, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 10, 0)),
      }),
      event({
        id: 'evt-b',
        startsAt: iso(Date.UTC(2026, 6, 18, 9, 30)),
        endsAt: iso(Date.UTC(2026, 6, 18, 10, 30)),
      }),
    ];

    expect(agendaForDay(events, DAY).every((item) => item.overlaps)).toBe(true);
  });

  it('does not flag two disjoint events', () => {
    const events = [
      event({
        id: 'evt-a',
        startsAt: iso(Date.UTC(2026, 6, 18, 9, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 10, 0)),
      }),
      event({
        id: 'evt-b',
        startsAt: iso(Date.UTC(2026, 6, 18, 11, 0)),
        endsAt: iso(Date.UTC(2026, 6, 18, 12, 0)),
      }),
    ];

    expect(agendaForDay(events, DAY).some((item) => item.overlaps)).toBe(false);
  });
});

describe('nextInAgenda', () => {
  const item = (id: string, endsAt: string) => ({ id, endsAt });

  it('picks the first item on today that has not ended yet', () => {
    const items = [item('a', iso(Date.UTC(2026, 6, 18, 13, 0))), item('b', iso(Date.UTC(2026, 6, 18, 15, 0)))];
    const now = new Date(iso(Date.UTC(2026, 6, 18, 12, 0)));

    expect(nextInAgenda(items, now, true)?.id).toBe('a');
  });

  it('skips an already-ended item on today', () => {
    const items = [item('a', iso(Date.UTC(2026, 6, 18, 11, 0))), item('b', iso(Date.UTC(2026, 6, 18, 15, 0)))];
    const now = new Date(iso(Date.UTC(2026, 6, 18, 12, 0)));

    expect(nextInAgenda(items, now, true)?.id).toBe('b');
  });

  it('picks the first item on a day that is not today', () => {
    const items = [item('a', iso(Date.UTC(2026, 6, 19, 9, 0))), item('b', iso(Date.UTC(2026, 6, 19, 15, 0)))];
    const now = new Date(iso(Date.UTC(2026, 6, 18, 12, 0)));

    expect(nextInAgenda(items, now, false)?.id).toBe('a');
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

describe('dayWindow', () => {
  it('returns 2*radius+1 keys, the anchor itself the middle entry', () => {
    expect(dayWindow('2026-07-18', 2)).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
    ]);
  });

  it('steps single days, not whole weeks', () => {
    const days = dayWindow('2026-07-18', 3);
    for (let i = 1; i < days.length; i += 1) {
      expect(dateKeyDiff(days[i - 1], days[i])).toBe(1);
    }
  });

  it('crosses a month boundary on both sides', () => {
    expect(dayWindow('2026-08-01', 2)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('crosses a year boundary on both sides', () => {
    expect(dayWindow('2027-01-01', 2)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });
});

describe('weekWindow', () => {
  it('returns 2*radius+1 Mon-Sun weeks, the anchor\'s own week the middle entry', () => {
    // 2026-07-18 is a Saturday, so its own week starts Monday 2026-07-13.
    const weeks = weekWindow('2026-07-18', 1);
    expect(weeks).toHaveLength(3);
    expect(weeks[0][0]).toBe('2026-07-06');
    expect(weeks[1]).toEqual(weekDaysFor('2026-07-18'));
    expect(weeks[2][0]).toBe('2026-07-20');
  });

  it('steps whole weeks, not partial ones', () => {
    const weeks = weekWindow('2026-07-18', 2);
    for (let i = 1; i < weeks.length; i += 1) {
      expect(dateKeyDiff(weeks[i - 1][0], weeks[i][0])).toBe(7);
    }
  });

  it('crosses a month boundary on both sides', () => {
    const weeks = weekWindow('2026-08-02', 1);
    expect(weeks[0][0]).toBe('2026-07-20');
    expect(weeks[2][0]).toBe('2026-08-03');
  });

  it('crosses a year boundary on both sides', () => {
    const weeks = weekWindow('2027-01-02', 1);
    expect(weeks[0][0]).toBe('2026-12-21');
    expect(weeks[2][0]).toBe('2027-01-04');
  });

  it("works from a Sunday anchor too, matching weekDaysFor's own Sunday special-case", () => {
    // 2026-07-19 is a Sunday — the last day of its own Mon-Sun week, not the
    // first of the next (weekDaysFor's doc comment).
    const weeks = weekWindow('2026-07-19', 1);
    expect(weeks[1][0]).toBe('2026-07-13');
  });
});

describe('addMonths', () => {
  it('advances a date key by whole months', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15');
  });

  it('rolls back across a year boundary', () => {
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('rolls forward across a year boundary', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('addMonthsClamped', () => {
  it('clamps to the shorter month\'s last day when the source day-of-month overflows it', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('lands on 29 February in a leap year instead of clamping to the 28th', () => {
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('rolls forward across a year boundary, same day-of-month', () => {
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('rolls backward across a year boundary, same day-of-month', () => {
    expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('clamps backward too — 31 March minus one month has no 31st in February', () => {
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
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

describe('monthDaysFor', () => {
  it('pads a month that starts mid-week with real neighbour-month days, 35 keys total', () => {
    // July 2026 starts on a Wednesday (same month due-today.test.ts uses for
    // its habits month grid): 2 leading June days, 31 July days, 2 trailing
    // August days.
    const days = monthDaysFor('2026-07-18');
    expect(days).toHaveLength(35);
    expect(days[0]).toBe('2026-06-29');
    expect(days[2]).toBe('2026-07-01');
    expect(days[32]).toBe('2026-07-31');
    expect(days[34]).toBe('2026-08-02');
  });

  it('grows to 42 keys when the month needs six full weeks', () => {
    // November 2026 starts on a Sunday: 6 leading October days, 30 November
    // days, 6 trailing December days.
    const days = monthDaysFor('2026-11-15');
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-10-26');
    expect(days[days.length - 1]).toBe('2026-12-06');
  });

  it('needs no leading neighbour days when the month starts on a Monday', () => {
    // June 2026 starts on a Monday.
    const days = monthDaysFor('2026-06-10');
    expect(days[0]).toBe('2026-06-01');
  });

  it('is always a multiple of 7, for every month', () => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `2026-${String(month).padStart(2, '0')}-15`;
      expect(monthDaysFor(key).length % 7).toBe(0);
    }
  });

  it("contains the month's own first and last date key", () => {
    const days = monthDaysFor('2026-07-18');
    expect(days).toContain('2026-07-01');
    expect(days).toContain('2026-07-31');
  });
});

describe('categoriesForDay', () => {
  const DAY = '2026-07-18';

  function withStart(overrides: Partial<EventView>): EventView {
    return event({ startsAt: `${DAY}T09:00:00.000Z`, endsAt: `${DAY}T10:00:00.000Z`, ...overrides });
  }

  it('dedupes two events of the same category into a single dot', () => {
    const events = [withStart({ category: 'arbeit' }), withStart({ category: 'arbeit' })];
    expect(categoriesForDay(events, DAY)).toEqual(['arbeit']);
  });

  it('orders categories stably, unkategorisiert last', () => {
    const events = [
      withStart({ category: 'sport' }),
      withStart({ category: null }),
      withStart({ category: 'arbeit' }),
    ];
    expect(categoriesForDay(events, DAY)).toEqual(['arbeit', 'sport', null]);
  });

  it('returns an empty list for a day without events', () => {
    expect(categoriesForDay([], DAY)).toEqual([]);
  });

  it('ignores events on other days', () => {
    const events = [withStart({ startsAt: '2026-07-19T09:00:00.000Z', endsAt: '2026-07-19T10:00:00.000Z' })];
    expect(categoriesForDay(events, DAY)).toEqual([]);
  });

  it('caps at 4 dots even when all 5 categories plus unkategorisiert are present', () => {
    const events = (['privat', 'arbeit', 'gesundheit', 'sport', 'familie', null] as const).map((category) =>
      withStart({ category }),
    );
    expect(categoriesForDay(events, DAY)).toHaveLength(4);
    expect(categoriesForDay(events, DAY)).toEqual(['privat', 'arbeit', 'gesundheit', 'sport']);
  });
});

/**
 * The dots read expanded occurrences, exactly as calendar-strip.tsx composes
 * the two (issue #612) — before that, `categoriesForDay` filtered raw `events`
 * rows by `startsAt`, so a series was dotted only on its anchor day, a cancelled
 * instance kept its dot, and an all-day event never got one at all.
 */
describe('categoriesForDay over expandForDay', () => {
  function dotsOn(
    events: EventView[],
    exceptions: EventExceptionView[],
    dayKey: string,
  ): EventView['category'][] {
    return categoriesForDay(expandForDay(events, exceptions, dayKey), dayKey);
  }

  const weeklySeries = event({
    // Monday 2026-07-13, 09:00 Berlin.
    startsAt: '2026-07-13T07:00:00.000Z',
    endsAt: '2026-07-13T08:00:00.000Z',
    category: 'arbeit',
    recurrence: { freq: 'weekly', interval: 1 },
  });

  it('dots every occurrence of a series, not just its anchor day', () => {
    expect(dotsOn([weeklySeries], [], '2026-07-13')).toEqual(['arbeit']);
    expect(dotsOn([weeklySeries], [], '2026-07-20')).toEqual(['arbeit']);
    // Across the month boundary — the strip renders neighbour-month days too.
    expect(dotsOn([weeklySeries], [], '2026-08-03')).toEqual(['arbeit']);
  });

  it('leaves the days between two occurrences undotted', () => {
    expect(dotsOn([weeklySeries], [], '2026-07-16')).toEqual([]);
  });

  it('drops the dot of a cancelled occurrence, keeping the rest of the series', () => {
    const cancelled: EventExceptionView = {
      id: 'exc-1',
      eventId: 'evt-1',
      originalDate: '2026-07-20',
      cancelled: true,
      overrideStartsAt: null,
      overrideEndsAt: null,
      overrideStartDate: null,
      overrideEndDate: null,
    };

    expect(dotsOn([weeklySeries], [cancelled], '2026-07-20')).toEqual([]);
    expect(dotsOn([weeklySeries], [cancelled], '2026-07-27')).toEqual(['arbeit']);
  });

  it('dots an all-day event, which carries no startsAt at all', () => {
    const allDay = event({
      allDay: true,
      startDate: '2026-07-18',
      endDate: '2026-07-18',
      category: 'privat',
    });

    expect(dotsOn([allDay], [], '2026-07-18')).toEqual(['privat']);
  });

  it('dots every day a multi-day event spans, not only its first', () => {
    const trip = event({
      allDay: true,
      startDate: '2026-07-18',
      endDate: '2026-07-20',
      category: 'familie',
    });

    expect(dotsOn([trip], [], '2026-07-18')).toEqual(['familie']);
    expect(dotsOn([trip], [], '2026-07-19')).toEqual(['familie']);
    expect(dotsOn([trip], [], '2026-07-20')).toEqual(['familie']);
    expect(dotsOn([trip], [], '2026-07-21')).toEqual([]);
  });

  it('dots a recurring all-day series on a later occurrence', () => {
    const series = event({
      allDay: true,
      startDate: '2026-07-18',
      endDate: '2026-07-18',
      category: 'sport',
      recurrence: { freq: 'weekly', interval: 1 },
    });

    expect(dotsOn([series], [], '2026-07-25')).toEqual(['sport']);
  });

  it('stops dotting a series after its until date', () => {
    const bounded = event({
      startsAt: '2026-07-13T07:00:00.000Z',
      endsAt: '2026-07-13T08:00:00.000Z',
      category: 'gesundheit',
      recurrence: { freq: 'weekly', interval: 1, until: '2026-07-20' },
    });

    expect(dotsOn([bounded], [], '2026-07-20')).toEqual(['gesundheit']);
    expect(dotsOn([bounded], [], '2026-07-27')).toEqual([]);
  });
});

/**
 * Same expandForDay composition as "categoriesForDay over expandForDay" above
 * — the chip counts read the same rendered occurrences the strip's dots do.
 */
describe('monthEventCounts', () => {
  function countsFor(events: EventView[], exceptions: EventExceptionView[], focusMonth: string) {
    return monthEventCounts(focusMonth, (day) => expandForDay(events, exceptions, day));
  }

  it('reports 0/0 for an empty month', () => {
    expect(countsFor([], [], '2026-07')).toEqual({ total: 0, allDay: 0 });
  });

  it('counts a single scheduled event once', () => {
    const single = event({
      startsAt: '2026-07-18T09:00:00.000Z',
      endsAt: '2026-07-18T10:00:00.000Z',
    });

    expect(countsFor([single], [], '2026-07')).toEqual({ total: 1, allDay: 0 });
  });

  it('counts a multi-day all-day event once, not once per day it spans', () => {
    const trip = event({ allDay: true, startDate: '2026-07-18', endDate: '2026-07-20' });

    expect(countsFor([trip], [], '2026-07')).toEqual({ total: 1, allDay: 1 });
  });

  it('counts a weekly series once per occurrence in the month', () => {
    const weekly = event({
      // Every Monday in July 2026: 6, 13, 20, 27.
      startsAt: '2026-07-06T07:00:00.000Z',
      endsAt: '2026-07-06T08:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 1 },
    });

    expect(countsFor([weekly], [], '2026-07')).toEqual({ total: 4, allDay: 0 });
  });

  it('separates all-day from timed in the allDay subset', () => {
    const timed = event({
      id: 'timed-1',
      startsAt: '2026-07-10T09:00:00.000Z',
      endsAt: '2026-07-10T10:00:00.000Z',
    });
    const allDay = event({ id: 'allday-1', allDay: true, startDate: '2026-07-11', endDate: '2026-07-11' });

    expect(countsFor([timed, allDay], [], '2026-07')).toEqual({ total: 2, allDay: 1 });
  });

  it('excludes a neighbour-month day even though monthDaysFor grids it in', () => {
    // 2026-07-01 is a Wednesday — the grid's leading week reaches back into June.
    const juneEdge = event({
      startsAt: '2026-06-29T09:00:00.000Z',
      endsAt: '2026-06-29T10:00:00.000Z',
    });

    expect(countsFor([juneEdge], [], '2026-07')).toEqual({ total: 0, allDay: 0 });
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

describe('allDayRangeLabel', () => {
  it('reads plain "Ganztägig" for a single day, no continuation either side', () => {
    const item = { startDate: '2026-07-18', endDate: '2026-07-18', continuesBefore: false, continuesAfter: false };

    expect(allDayRangeLabel(item)).toBe('Ganztägig');
  });

  it('shows the full weekday range on the start day of a multi-day span', () => {
    // 2026-07-20 is a Monday, 2026-07-24 a Friday.
    const item = { startDate: '2026-07-20', endDate: '2026-07-24', continuesBefore: false, continuesAfter: true };

    expect(allDayRangeLabel(item)).toBe('Ganztägig · Mo–Fr');
  });

  it('shows the same full range on a middle day of the span', () => {
    const item = { startDate: '2026-07-20', endDate: '2026-07-24', continuesBefore: true, continuesAfter: true };

    expect(allDayRangeLabel(item)).toBe('Ganztägig · Mo–Fr');
  });

  it('shows the same full range on the end day of the span', () => {
    const item = { startDate: '2026-07-20', endDate: '2026-07-24', continuesBefore: true, continuesAfter: false };

    expect(allDayRangeLabel(item)).toBe('Ganztägig · Mo–Fr');
  });

  it('stays correct across a month boundary', () => {
    // 2026-07-30 is a Thursday, 2026-08-02 a Sunday.
    const item = { startDate: '2026-07-30', endDate: '2026-08-02', continuesBefore: false, continuesAfter: true };

    expect(allDayRangeLabel(item)).toBe('Ganztägig · Do–So');
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

describe('formatMonthTitle', () => {
  it('formats month and year, German', () => {
    expect(formatMonthTitle('2026-07-18')).toBe('Juli 2026');
  });

  it('does not shift the month for the first day, UTC-anchored', () => {
    expect(formatMonthTitle('2026-08-01')).toBe('August 2026');
  });

  it('does not shift the year for the last day of the year', () => {
    expect(formatMonthTitle('2026-12-31')).toBe('Dezember 2026');
  });
});

describe('monthName', () => {
  it('formats only the month, German', () => {
    expect(monthName('2026-07-18')).toBe('Juli');
  });

  it('does not shift the month for the first day, UTC-anchored', () => {
    expect(monthName('2026-08-01')).toBe('August');
  });
});

describe('yearLabel', () => {
  it('formats only the year', () => {
    expect(yearLabel('2026-07-18')).toBe('2026');
  });

  it('does not shift the year for the last day of the year', () => {
    expect(yearLabel('2026-12-31')).toBe('2026');
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

describe('formatDuration', () => {
  it('reports whole minutes under an hour', () => {
    expect(formatDuration(iso(Date.UTC(2026, 6, 18, 9, 0)), iso(Date.UTC(2026, 6, 18, 9, 30)))).toBe(
      '30 Min',
    );
  });

  it('omits minutes on an exact hour', () => {
    expect(formatDuration(iso(Date.UTC(2026, 6, 18, 9, 0)), iso(Date.UTC(2026, 6, 18, 10, 0)))).toBe(
      '1 Std',
    );
  });

  it('reports hours and minutes over an hour', () => {
    expect(formatDuration(iso(Date.UTC(2026, 6, 18, 9, 0)), iso(Date.UTC(2026, 6, 18, 10, 30)))).toBe(
      '1 Std 30 Min',
    );
  });

  it('reports multiple whole hours', () => {
    expect(formatDuration(iso(Date.UTC(2026, 6, 18, 9, 0)), iso(Date.UTC(2026, 6, 18, 12, 0)))).toBe(
      '3 Std',
    );
  });
});
