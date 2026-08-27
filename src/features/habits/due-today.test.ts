import { describe, expect, it } from 'vitest';
import {
  addMonths,
  currentWeekRange,
  dayLabel,
  habitsDueToday,
  metEarlierInPeriod,
  monthDays,
  monthLabel,
  startOfMonth,
  toDateKey,
} from './due-today';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const habit = (overrides: Partial<HabitView>): HabitView => ({
  id: 'habit-1',
  name: 'x',
  schedule: 'daily',
  target: 1,
  color: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

const log = (overrides: Partial<HabitLogView>): HabitLogView => ({
  id: 'log-1',
  habitId: 'habit-1',
  logDate: '2026-07-15',
  done: true,
  ...overrides,
});

// A Wednesday, per docs/DESIGN_SYSTEM.md examples elsewhere (2026-07-15).
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('toDateKey', () => {
  it('formats the local calendar day as YYYY-MM-DD', () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('currentWeekRange', () => {
  it('spans Monday through Sunday for a mid-week date', () => {
    expect(currentWeekRange(WEDNESDAY)).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('treats Sunday as the last day of its own week, not the next one', () => {
    const sunday = new Date(2026, 6, 19, 8, 0);
    expect(currentWeekRange(sunday)).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('treats Monday as the first day of its own week', () => {
    const monday = new Date(2026, 6, 13, 8, 0);
    expect(currentWeekRange(monday)).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });
});

describe('metEarlierInPeriod', () => {
  it('a daily habit never carries the hint, done or not (issue #509: one-day period)', () => {
    expect(metEarlierInPeriod(habit({ schedule: 'daily' }), [], WEDNESDAY)).toBe(false);
    expect(
      metEarlierInPeriod(
        habit({ schedule: 'daily' }),
        [log({ logDate: '2026-07-15', done: true })],
        WEDNESDAY,
      ),
    ).toBe(false);
  });

  it('a custom-schedule habit never carries the hint (no due-logic exists for it yet)', () => {
    expect(metEarlierInPeriod(habit({ schedule: 'custom' }), [], WEDNESDAY)).toBe(false);
  });

  it('a weekly habit with no log this week has no hint', () => {
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), [], WEDNESDAY)).toBe(false);
  });

  it('a weekly habit done earlier this week has the hint', () => {
    const logs = [log({ logDate: '2026-07-13', done: true })];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(true);
  });

  it('a weekly habit done last week has no hint this week', () => {
    const logs = [log({ logDate: '2026-07-06', done: true })];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('a weekly habit checked off today has no hint (it is already shown as done, AC4)', () => {
    const logs = [log({ logDate: '2026-07-15', done: true })];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('a weekly habit with only an undone log this week has no hint', () => {
    const logs = [log({ logDate: '2026-07-13', done: false })];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('ignores logs for a different habit', () => {
    const logs = [log({ habitId: 'other-habit', logDate: '2026-07-13', done: true })];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  // Friday this week, so Mon–Thu are all "earlier" days to seed logs on.
  const FRIDAY = new Date(2026, 6, 17, 12, 0, 0);

  it('a "3x pro Woche" habit with only 2 earlier logs this week has no hint yet (issue #509 AC2)', () => {
    const logs = [
      log({ logDate: '2026-07-13', done: true }),
      log({ logDate: '2026-07-14', done: true }),
    ];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly', target: 3 }), logs, FRIDAY)).toBe(false);
  });

  it('a "3x pro Woche" habit with 3 earlier logs this week has the hint (issue #509 AC3)', () => {
    const logs = [
      log({ logDate: '2026-07-13', done: true }),
      log({ logDate: '2026-07-14', done: true }),
      log({ logDate: '2026-07-16', done: true }),
    ];
    expect(metEarlierInPeriod(habit({ schedule: 'weekly', target: 3 }), logs, FRIDAY)).toBe(true);
  });

  it('a monthly habit done on the 3rd carries the hint on the 4th (issue #509 AC4)', () => {
    const logs = [log({ logDate: '2026-07-03', done: true })];
    const fourth = new Date(2026, 6, 4, 12, 0, 0);
    expect(metEarlierInPeriod(habit({ schedule: 'monthly' }), logs, fourth)).toBe(true);
  });

  it('a monthly habit is open again once the month rolls over (issue #509 AC5)', () => {
    const logs = [log({ logDate: '2026-07-03', done: true })];
    const nextMonth = new Date(2026, 7, 1, 12, 0, 0);
    expect(metEarlierInPeriod(habit({ schedule: 'monthly' }), logs, nextMonth)).toBe(false);
  });
});

describe('habitsDueToday (issue #863)', () => {
  it('keine Routinen → {0, 0}', () => {
    expect(habitsDueToday([], [], WEDNESDAY)).toEqual({ done: 0, due: 0 });
  });

  it('zählt nur nicht-archivierte Routinen, die heute noch nicht früher in der Periode erledigt wurden', () => {
    const habits = [
      habit({ id: 'a', schedule: 'daily' }),
      habit({ id: 'b', schedule: 'daily', archivedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const logs = [log({ habitId: 'a', logDate: '2026-07-15', done: true })];
    expect(habitsDueToday(habits, logs, WEDNESDAY)).toEqual({ done: 1, due: 1 });
  });

  it('eine Routine, deren Wochenziel schon früher erreicht wurde, fällt aus Zähler und Nenner', () => {
    const habits = [habit({ id: 'a', schedule: 'weekly', target: 1 })];
    const logs = [log({ habitId: 'a', logDate: '2026-07-13', done: true })]; // schon diese Woche erledigt
    expect(habitsDueToday(habits, logs, WEDNESDAY)).toEqual({ done: 0, due: 0 });
  });
});

describe('startOfMonth / addMonths (issue #124)', () => {
  it('normalizes any day of the month to its 1st', () => {
    expect(startOfMonth(WEDNESDAY)).toEqual(new Date(2026, 6, 1));
  });

  it('steps forward and backward across a year boundary', () => {
    expect(addMonths(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 1));
    expect(addMonths(new Date(2025, 11, 1), 1)).toEqual(new Date(2026, 0, 1));
  });
});

describe('monthLabel / dayLabel (issue #124)', () => {
  it('formats month and year in German', () => {
    expect(monthLabel(new Date(2026, 6, 1))).toBe('Juli 2026');
  });

  it('formats a date key as day, month and year', () => {
    expect(dayLabel('2026-07-05')).toBe('5. Juli 2026');
  });
});

describe('monthDays (issue #124 AC1, neighbour days added in #487)', () => {
  it('pads a month that starts mid-week with real days of the previous/next month', () => {
    // July 2026 starts on a Wednesday: 2 leading days from June, 31 July
    // days, 2 trailing days from August.
    const days = monthDays(new Date(2026, 6, 15));
    expect(days).toHaveLength(35);
    expect(days.slice(0, 2)).toEqual([
      { dateKey: '2026-06-29', inMonth: false },
      { dateKey: '2026-06-30', inMonth: false },
    ]);
    expect(days[2]).toEqual({ dateKey: '2026-07-01', inMonth: true });
    expect(days[32]).toEqual({ dateKey: '2026-07-31', inMonth: true });
    expect(days.slice(33)).toEqual([
      { dateKey: '2026-08-01', inMonth: false },
      { dateKey: '2026-08-02', inMonth: false },
    ]);
  });

  it('needs no leading neighbour days when the month starts on a Monday', () => {
    // June 2026 starts on a Monday.
    const days = monthDays(new Date(2026, 5, 10));
    expect(days[0]).toEqual({ dateKey: '2026-06-01', inMonth: true });
    expect(days.filter((day) => day.inMonth)).toHaveLength(30);
  });

  it('is always a multiple of 7', () => {
    for (let month = 0; month < 12; month += 1) {
      expect(monthDays(new Date(2026, month, 1)).length % 7).toBe(0);
    }
  });

  it('carries real date keys across a year boundary', () => {
    // December 2026 starts on a Tuesday (1 leading day from November) and
    // has 31 days, ending on a Thursday (3 trailing days into January 2027).
    const days = monthDays(new Date(2026, 11, 15));
    expect(days[0]).toEqual({ dateKey: '2026-11-30', inMonth: false });
    expect(days[days.length - 1]).toEqual({ dateKey: '2027-01-03', inMonth: false });
  });
});
