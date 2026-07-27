import { describe, expect, it } from 'vitest';
import {
  addMonths,
  currentWeekRange,
  dayLabel,
  doneEarlierThisWeek,
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

describe('doneEarlierThisWeek', () => {
  it('a daily habit never carries the week hint, done or not', () => {
    expect(doneEarlierThisWeek(habit({ schedule: 'daily' }), [], WEDNESDAY)).toBe(false);
    expect(
      doneEarlierThisWeek(
        habit({ schedule: 'daily' }),
        [log({ logDate: '2026-07-15', done: true })],
        WEDNESDAY,
      ),
    ).toBe(false);
  });

  it('a custom-schedule habit never carries the week hint (no due-logic exists for it yet)', () => {
    expect(doneEarlierThisWeek(habit({ schedule: 'custom' }), [], WEDNESDAY)).toBe(false);
  });

  it('a weekly habit with no log this week has no hint', () => {
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), [], WEDNESDAY)).toBe(false);
  });

  it('a weekly habit done earlier this week has the hint', () => {
    const logs = [log({ logDate: '2026-07-13', done: true })];
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(true);
  });

  it('a weekly habit done last week has no hint this week', () => {
    const logs = [log({ logDate: '2026-07-06', done: true })];
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('a weekly habit checked off today has no hint (it is already shown as done, AC4)', () => {
    const logs = [log({ logDate: '2026-07-15', done: true })];
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('a weekly habit with only an undone log this week has no hint', () => {
    const logs = [log({ logDate: '2026-07-13', done: false })];
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
  });

  it('ignores logs for a different habit', () => {
    const logs = [log({ habitId: 'other-habit', logDate: '2026-07-13', done: true })];
    expect(doneEarlierThisWeek(habit({ schedule: 'weekly' }), logs, WEDNESDAY)).toBe(false);
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

describe('monthDays (issue #124 AC1)', () => {
  it('pads a month that starts mid-week to full Mon–Sun rows', () => {
    // July 2026 starts on a Wednesday: 2 leading blanks, 31 days, 2 trailing.
    const days = monthDays(new Date(2026, 6, 15));
    expect(days).toHaveLength(35);
    expect(days.slice(0, 2)).toEqual([null, null]);
    expect(days[2]).toBe('2026-07-01');
    expect(days[32]).toBe('2026-07-31');
    expect(days.slice(33)).toEqual([null, null]);
  });

  it('needs no leading blanks when the month starts on a Monday', () => {
    // June 2026 starts on a Monday.
    const days = monthDays(new Date(2026, 5, 10));
    expect(days[0]).toBe('2026-06-01');
    expect(days.filter((day) => day !== null)).toHaveLength(30);
  });

  it('is always a multiple of 7', () => {
    for (let month = 0; month < 12; month += 1) {
      expect(monthDays(new Date(2026, month, 1)).length % 7).toBe(0);
    }
  });
});
