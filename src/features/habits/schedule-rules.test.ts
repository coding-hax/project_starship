import { describe, expect, it } from 'vitest';
import {
  addDaysToKey,
  dayBefore,
  doneCountInPeriod,
  isDoneOnDay,
  isoWeek,
  isTargetMet,
  periodRangeFor,
  periodStatusFor,
  weekRangeForDay,
} from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';

function log(overrides: Partial<HabitLogView> = {}): HabitLogView {
  return { id: 'log', habitId: 'habit-1', logDate: '2026-07-15', done: true, ...overrides };
}

describe('weekRangeForDay', () => {
  it('a Wednesday falls in the Mon–Sun week starting that Monday', () => {
    expect(weekRangeForDay('2026-07-15')).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('a Sunday is the last day of its own week, not the next one', () => {
    expect(weekRangeForDay('2026-07-19')).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('the following Monday starts a new week', () => {
    expect(weekRangeForDay('2026-07-20')).toEqual({ start: '2026-07-20', end: '2026-07-26' });
  });

  it('crosses a month boundary correctly', () => {
    expect(weekRangeForDay('2026-08-01')).toEqual({ start: '2026-07-27', end: '2026-08-02' });
  });
});

describe('addDaysToKey / dayBefore', () => {
  it('shifts across a month boundary', () => {
    expect(addDaysToKey('2026-08-01', -1)).toBe('2026-07-31');
    expect(dayBefore('2026-08-01')).toBe('2026-07-31');
  });

  it('shifts across a year boundary', () => {
    expect(addDaysToKey('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('isoWeek', () => {
  it('1 January 2026 (a Thursday) is week 1 of 2026', () => {
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
  });

  it('31 December 2025 already belongs to ISO week 1 of 2026', () => {
    expect(isoWeek('2025-12-31')).toEqual({ year: 2026, week: 1 });
  });

  it('2026 has 53 ISO weeks — 28 December falls in week 53', () => {
    expect(isoWeek('2026-12-28')).toEqual({ year: 2026, week: 53 });
  });

  it('1 January 2021 still belongs to ISO week 53 of 2020', () => {
    expect(isoWeek('2021-01-01')).toEqual({ year: 2020, week: 53 });
  });
});

describe('periodRangeFor', () => {
  it('daily and custom are a single day', () => {
    expect(periodRangeFor({ schedule: 'daily' }, '2026-07-15')).toEqual({
      start: '2026-07-15',
      end: '2026-07-15',
    });
    expect(periodRangeFor({ schedule: 'custom' }, '2026-07-15')).toEqual({
      start: '2026-07-15',
      end: '2026-07-15',
    });
  });

  it('weekly is the Mon–Sun week', () => {
    expect(periodRangeFor({ schedule: 'weekly' }, '2026-07-15')).toEqual({
      start: '2026-07-13',
      end: '2026-07-19',
    });
  });

  it('biweekly pairs an odd ISO week forward with the next (even) week', () => {
    // 2026-01-01 falls in ISO week 1 (odd) of 2026.
    expect(periodRangeFor({ schedule: 'biweekly' }, '2026-01-01')).toEqual({
      start: '2025-12-29',
      end: '2026-01-11',
    });
  });

  it('biweekly pairs an even ISO week backward with the previous (odd) week', () => {
    // 2026-01-08 falls in ISO week 2 (even) of 2026.
    expect(periodRangeFor({ schedule: 'biweekly' }, '2026-01-08')).toEqual({
      start: '2025-12-29',
      end: '2026-01-11',
    });
  });

  it('biweekly: an odd last-ISO-week-of-year (KW53→KW1 rollover) stands alone', () => {
    // 2026-12-28 falls in ISO week 53 (odd) of 2026, the last week of that year.
    expect(periodRangeFor({ schedule: 'biweekly' }, '2026-12-28')).toEqual({
      start: '2026-12-28',
      end: '2027-01-03',
    });
  });

  it('monthly is the first–last day of the month', () => {
    expect(periodRangeFor({ schedule: 'monthly' }, '2026-02-14')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });

  it('monthly handles a leap-year February', () => {
    expect(periodRangeFor({ schedule: 'monthly' }, '2028-02-14')).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
  });

  it('quarterly is the Jan–Mar/Apr–Jun/Jul–Sep/Oct–Dec quarter', () => {
    expect(periodRangeFor({ schedule: 'quarterly' }, '2026-05-10')).toEqual({
      start: '2026-04-01',
      end: '2026-06-30',
    });
    expect(periodRangeFor({ schedule: 'quarterly' }, '2026-12-31')).toEqual({
      start: '2026-10-01',
      end: '2026-12-31',
    });
  });

  it('yearly is 1 January–31 December', () => {
    expect(periodRangeFor({ schedule: 'yearly' }, '2026-05-10')).toEqual({
      start: '2026-01-01',
      end: '2026-12-31',
    });
  });
});

describe('isDoneOnDay', () => {
  it('true only for a done log on the exact day for that habit', () => {
    const logs = [log({ logDate: '2026-07-15' })];
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-15')).toBe(true);
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-16')).toBe(false);
    expect(isDoneOnDay(logs, 'other-habit', '2026-07-15')).toBe(false);
  });

  it('an undone log does not count', () => {
    const logs = [log({ done: false })];
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-15')).toBe(false);
  });
});

describe('doneCountInPeriod', () => {
  const week = { start: '2026-07-13', end: '2026-07-19' };

  it('counts every done log inside the range for that habit', () => {
    const logs = [
      log({ logDate: '2026-07-14' }),
      log({ logDate: '2026-07-16' }),
      log({ logDate: '2026-07-20' }), // outside the range
      log({ logDate: '2026-07-15', habitId: 'other-habit' }), // different habit
      log({ logDate: '2026-07-17', done: false }), // not done
    ];
    expect(doneCountInPeriod(logs, 'habit-1', week)).toBe(2);
  });

  it('zero when nothing is done for that habit', () => {
    expect(doneCountInPeriod([log({ done: false })], 'habit-1', week)).toBe(0);
  });
});

describe('isTargetMet', () => {
  const week = { start: '2026-07-13', end: '2026-07-19' };

  it('true once the count reaches target', () => {
    const logs = [log({ logDate: '2026-07-14' }), log({ logDate: '2026-07-16' })];
    expect(isTargetMet({ id: 'habit-1', target: 2 }, logs, week)).toBe(true);
    expect(isTargetMet({ id: 'habit-1', target: 3 }, logs, week)).toBe(false);
  });
});

describe('periodStatusFor', () => {
  it('reports count/target/met for the habit\'s own period', () => {
    const logs = [log({ logDate: '2026-07-14' }), log({ logDate: '2026-07-16' })];
    const habit = { id: 'habit-1', schedule: 'weekly' as const, target: 3 };
    expect(periodStatusFor(habit, logs, '2026-07-15')).toEqual({ count: 2, target: 3, met: false });
  });

  it('met is true once count >= target', () => {
    const logs = [
      log({ logDate: '2026-07-14' }),
      log({ logDate: '2026-07-15' }),
      log({ logDate: '2026-07-16' }),
    ];
    const habit = { id: 'habit-1', schedule: 'weekly' as const, target: 3 };
    expect(periodStatusFor(habit, logs, '2026-07-15')).toEqual({ count: 3, target: 3, met: true });
  });
});
