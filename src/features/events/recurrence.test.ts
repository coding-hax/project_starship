import { describe, expect, it } from 'vitest';
import { expandForDay, occurrencesOnDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

function event(overrides: Partial<EventView>): EventView {
  return {
    id: 'evt-1',
    title: 'Serie',
    allDay: false,
    startsAt: null,
    endsAt: null,
    startDate: null,
    endDate: null,
    category: null,
    recurrence: null,
    origin: 'local',
    ...overrides,
  };
}

function exception(overrides: Partial<EventExceptionView>): EventExceptionView {
  return {
    id: 'exc-1',
    eventId: 'evt-1',
    originalDate: '2026-07-20',
    cancelled: false,
    overrideStartsAt: null,
    overrideEndsAt: null,
    overrideStartDate: null,
    overrideEndDate: null,
    ...overrides,
  };
}

describe('occurrencesOnDay — weekly', () => {
  const rule = { freq: 'weekly' as const, interval: 1, byWeekday: [0] }; // Monday

  it('stays on the right weekday across a month boundary (AC1)', () => {
    // 2026-07-27 is a Monday; the following Monday crosses into August.
    expect(occurrencesOnDay(rule, '2026-07-27', '2026-08-03')).toBe(true);
    expect(occurrencesOnDay(rule, '2026-07-27', '2026-08-04')).toBe(false);
  });

  it('does not occur before the anchor', () => {
    expect(occurrencesOnDay(rule, '2026-07-27', '2026-07-20')).toBe(false);
  });

  it('respects a week interval > 1 (every 2nd week)', () => {
    const biweekly = { ...rule, interval: 2 };
    expect(occurrencesOnDay(biweekly, '2026-07-27', '2026-08-03')).toBe(false); // 1 week later
    expect(occurrencesOnDay(biweekly, '2026-07-27', '2026-08-10')).toBe(true); // 2 weeks later
  });

  it('matches any of several byWeekday entries', () => {
    const monWed = { ...rule, byWeekday: [0, 2] }; // Mon, Wed
    expect(occurrencesOnDay(monWed, '2026-07-27', '2026-07-29')).toBe(true); // Wed same week
    expect(occurrencesOnDay(monWed, '2026-07-27', '2026-07-30')).toBe(false); // Thu
  });

  it('defaults byWeekday to the anchor day when omitted', () => {
    const noByWeekday = { freq: 'weekly' as const, interval: 1 };
    expect(occurrencesOnDay(noByWeekday, '2026-07-27', '2026-08-03')).toBe(true);
  });
});

describe('occurrencesOnDay — DST (AC2)', () => {
  const rule = { freq: 'weekly' as const, interval: 1, byWeekday: [0] };

  it('a weekly series keeps landing on its weekday across the spring changeover (2026-03-29)', () => {
    // 2026-03-23 is the Monday before the spring changeover.
    expect(occurrencesOnDay(rule, '2026-03-23', '2026-03-30')).toBe(true);
  });

  it('a weekly series keeps landing on its weekday across the autumn changeover (2026-10-25)', () => {
    // 2026-10-19 is the Monday before the autumn changeover.
    expect(occurrencesOnDay(rule, '2026-10-19', '2026-10-26')).toBe(true);
  });
});

describe('occurrencesOnDay — daily', () => {
  it('occurs every `interval`th day', () => {
    const rule = { freq: 'daily' as const, interval: 3 };
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-04')).toBe(true);
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-05')).toBe(false);
  });
});

describe('occurrencesOnDay — monthly', () => {
  it('occurs on the same day-of-month every `interval` months', () => {
    const rule = { freq: 'monthly' as const, interval: 2 };
    expect(occurrencesOnDay(rule, '2026-01-15', '2026-03-15')).toBe(true);
    expect(occurrencesOnDay(rule, '2026-01-15', '2026-02-15')).toBe(false);
  });

  it('skips a month that has no 31st, without shifting to another day (Tag-31-Auslassung)', () => {
    const rule = { freq: 'monthly' as const, interval: 1 };
    expect(occurrencesOnDay(rule, '2026-01-31', '2026-02-28')).toBe(false);
    expect(occurrencesOnDay(rule, '2026-01-31', '2026-03-31')).toBe(true);
  });
});

describe('occurrencesOnDay — yearly', () => {
  it('occurs on the same month/day every `interval` years', () => {
    const rule = { freq: 'yearly' as const, interval: 1 };
    expect(occurrencesOnDay(rule, '2026-05-04', '2027-05-04')).toBe(true);
    expect(occurrencesOnDay(rule, '2026-05-04', '2027-05-05')).toBe(false);
  });

  it('skips a non-leap year for a 29 Feb anchor (29.02-Auslassung)', () => {
    const rule = { freq: 'yearly' as const, interval: 1 };
    expect(occurrencesOnDay(rule, '2024-02-29', '2025-02-28')).toBe(false);
    expect(occurrencesOnDay(rule, '2024-02-29', '2028-02-29')).toBe(true);
  });
});

describe('occurrencesOnDay — until/count', () => {
  it('stops once `until` has passed (inclusive)', () => {
    const rule = { freq: 'daily' as const, interval: 1, until: '2026-07-05' };
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-05')).toBe(true);
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-06')).toBe(false);
  });

  it('stops once `count` occurrences have happened', () => {
    const rule = { freq: 'daily' as const, interval: 1, count: 3 };
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-03')).toBe(true); // 3rd
    expect(occurrencesOnDay(rule, '2026-07-01', '2026-07-04')).toBe(false); // 4th
  });
});

describe('expandForDay', () => {
  it('passes a non-recurring event through unchanged', () => {
    const single = event({
      id: 'evt-single',
      title: 'Einzeltermin',
      startsAt: '2026-07-20T07:00:00.000Z',
      endsAt: '2026-07-20T08:00:00.000Z',
    });
    const result = expandForDay([single], [], '2026-07-20');
    expect(result).toEqual([
      {
        id: 'evt-single',
        eventId: 'evt-single',
        title: 'Einzeltermin',
        allDay: false,
        startsAt: '2026-07-20T07:00:00.000Z',
        endsAt: '2026-07-20T08:00:00.000Z',
        startDate: null,
        endDate: null,
        category: null,
      },
    ]);
  });

  it('expands a weekly series into an occurrence, preserving the 09:00 Berlin time', () => {
    const series = event({
      startsAt: '2026-07-20T07:00:00.000Z', // 09:00 Berlin, Monday
      endsAt: '2026-07-20T08:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    const result = expandForDay([series], [], '2026-07-27');
    expect(result).toEqual([
      {
        id: 'evt-1:2026-07-27',
        eventId: 'evt-1',
        originalDate: '2026-07-27',
        title: 'Serie',
        allDay: false,
        startsAt: '2026-07-27T07:00:00.000Z',
        endsAt: '2026-07-27T08:00:00.000Z',
        startDate: null,
        endDate: null,
        category: null,
      },
    ]);
  });

  it('produces no occurrence on a day the series does not land on', () => {
    const series = event({
      startsAt: '2026-07-20T07:00:00.000Z',
      endsAt: '2026-07-20T08:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    expect(expandForDay([series], [], '2026-07-21')).toEqual([]);
  });

  it('drops the instance a cancelling exception targets (AC4), keeping the series otherwise intact', () => {
    const series = event({
      startsAt: '2026-07-20T07:00:00.000Z',
      endsAt: '2026-07-20T08:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    const cancelled = exception({ originalDate: '2026-07-27', cancelled: true });

    expect(expandForDay([series], [cancelled], '2026-07-27')).toEqual([]);
    expect(expandForDay([series], [cancelled], '2026-08-03')).toHaveLength(1);
  });

  it('moves only the targeted instance when an exception overrides its time (AC3)', () => {
    const series = event({
      startsAt: '2026-07-20T07:00:00.000Z',
      endsAt: '2026-07-20T08:00:00.000Z',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    const moved = exception({
      originalDate: '2026-07-27',
      overrideStartsAt: '2026-07-27T15:00:00.000Z',
      overrideEndsAt: '2026-07-27T16:00:00.000Z',
    });

    const movedDay = expandForDay([series], [moved], '2026-07-27');
    expect(movedDay).toEqual([
      {
        id: 'evt-1:2026-07-27',
        eventId: 'evt-1',
        originalDate: '2026-07-27',
        title: 'Serie',
        allDay: false,
        startsAt: '2026-07-27T15:00:00.000Z',
        endsAt: '2026-07-27T16:00:00.000Z',
        startDate: null,
        endDate: null,
        category: null,
      },
    ]);

    // The following week's instance is untouched.
    const nextDay = expandForDay([series], [moved], '2026-08-03');
    expect(nextDay[0]).toMatchObject({ startsAt: '2026-08-03T07:00:00.000Z' });
  });

  it('expands an all-day series using pure date arithmetic, preserving the multi-day span', () => {
    const series = event({
      allDay: true,
      startDate: '2026-07-20',
      endDate: '2026-07-21',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: [0] },
    });
    const result = expandForDay([series], [], '2026-07-27');
    expect(result).toEqual([
      {
        id: 'evt-1:2026-07-27',
        eventId: 'evt-1',
        originalDate: '2026-07-27',
        title: 'Serie',
        allDay: true,
        startsAt: null,
        endsAt: null,
        startDate: '2026-07-27',
        endDate: '2026-07-28',
        category: null,
      },
    ]);
  });
});
