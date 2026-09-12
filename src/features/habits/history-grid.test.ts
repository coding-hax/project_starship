import { describe, expect, it } from 'vitest';
import {
  historyAxis,
  historyGrid,
  historyLeftEdge,
  isHabitDoneOnDay,
  visibleDoneCount,
  type HistoryGridDay,
} from './history-grid';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const habit = (overrides: Partial<HabitView> = {}): HabitView => ({
  id: 'habit-1',
  name: 'x',
  schedule: 'daily',
  target: 1,
  color: null,
  emoji: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

let logId = 0;
const log = (habitId: string, dateKey: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId,
  logDate: dateKey,
  done,
});

// Same reference Wednesday as streak.test.ts (2026-07-15).
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('historyGrid', () => {
  it('returns 30 days, oldest first and today last', () => {
    const grid = historyGrid([], [], WEDNESDAY);
    expect(grid.days).toHaveLength(30);
    expect(grid.days[0].dateKey).toBe('2026-06-16');
    expect(grid.days.at(-1)?.dateKey).toBe('2026-07-15');
  });

  it('marks a habit done on a day it has a done log', () => {
    const habits = [habit({ id: 'a' })];
    const logs = [log('a', '2026-07-15')];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.at(-1)?.habitIds).toEqual(['a']);
    expect(grid.days.at(-2)?.habitIds).toEqual([]);
  });

  it('a log older than the window moves the left edge back to that day (issue #1184 AK3)', () => {
    const habits = [habit({ id: 'a' })]; // createdAt 2026-07-01, 14 days before WEDNESDAY
    const logs = [log('a', '2026-06-01')]; // 44 days before WEDNESDAY
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days).toHaveLength(45); // 2026-06-01 .. 2026-07-15 inclusive
    expect(grid.days[0].dateKey).toBe('2026-06-01');
    expect(grid.days[0].habitIds).toEqual(['a']);
  });

  it('ignores a log marked not done', () => {
    const habits = [habit({ id: 'a' })];
    const logs = [log('a', '2026-07-15', false)];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.at(-1)?.habitIds).toEqual([]);
  });

  it('excludes an archived habit entirely, even with a log today', () => {
    const habits = [habit({ id: 'a', archivedAt: '2026-07-14T00:00:00.000Z' })];
    const logs = [log('a', '2026-07-15')];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.at(-1)?.habitIds).toEqual([]);
    expect(grid.total).toBe(0);
  });

  it('stacks done habits in compareHabits order (oldest createdAt first), regardless of input order', () => {
    const older = habit({ id: 'older', createdAt: '2026-06-01T00:00:00.000Z' });
    const newer = habit({ id: 'newer', createdAt: '2026-06-15T00:00:00.000Z' });
    const habits = [newer, older]; // deliberately out of order
    const logs = [log('newer', '2026-07-15'), log('older', '2026-07-15')];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.at(-1)?.habitIds).toEqual(['older', 'newer']);
  });

  it('sums every filled cell in the window as the total', () => {
    const habits = [habit({ id: 'a' }), habit({ id: 'b', createdAt: '2026-06-02T00:00:00.000Z' })];
    const logs = [log('a', '2026-07-15'), log('a', '2026-07-14'), log('b', '2026-07-15')];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.total).toBe(3);
  });

  it('no habits → every day empty, total 0', () => {
    const grid = historyGrid([], [], WEDNESDAY);
    expect(grid.days.every((day) => day.habitIds.length === 0)).toBe(true);
    expect(grid.total).toBe(0);
  });

  it('produces 30 consecutive calendar days with no gaps or duplicates', () => {
    const grid = historyGrid([], [], WEDNESDAY);
    const keys = grid.days.map((day) => day.dateKey);
    expect(new Set(keys).size).toBe(30);
    for (let i = 1; i < keys.length; i++) {
      const previous = new Date(keys[i - 1]);
      const current = new Date(keys[i]);
      expect((current.getTime() - previous.getTime()) / 86_400_000).toBe(1);
    }
  });

  it('keeps a habit that logged done twice on the same day to one cell', () => {
    const habits = [habit({ id: 'a' })];
    const logs = [log('a', '2026-07-15'), log('a', '2026-07-15')];
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.at(-1)?.habitIds).toEqual(['a']);
    expect(grid.total).toBe(1);
  });
});

describe('isHabitDoneOnDay', () => {
  it('is true when the habit id is in the day\'s done list', () => {
    const day = { dateKey: '2026-07-15', habitIds: ['a', 'b'] };
    expect(isHabitDoneOnDay(day, 'a')).toBe(true);
    expect(isHabitDoneOnDay(day, 'b')).toBe(true);
  });

  it('is false when the habit id is not in the day\'s done list', () => {
    const day = { dateKey: '2026-07-15', habitIds: ['a'] };
    expect(isHabitDoneOnDay(day, 'other')).toBe(false);
  });

  it('is false for a day with nothing done', () => {
    const day = { dateKey: '2026-07-15', habitIds: [] };
    expect(isHabitDoneOnDay(day, 'a')).toBe(false);
  });

  it('does not match a habit id that is only a substring of a done id', () => {
    const day = { dateKey: '2026-07-15', habitIds: ['habit-12'] };
    expect(isHabitDoneOnDay(day, 'habit-1')).toBe(false);
  });
});

describe('historyLeftEdge', () => {
  it('floors at windowDays - 1 days back when nothing reaches further', () => {
    const habits = [habit({ id: 'a' })]; // createdAt 2026-07-01, 14 days back
    expect(historyLeftEdge(habits, [], WEDNESDAY)).toBe('2026-06-16'); // 29 days back
  });

  it('moves to an active habit\'s createdAt when it is older than the floor', () => {
    const habits = [habit({ id: 'a', createdAt: '2026-05-01T00:00:00.000Z' })];
    expect(historyLeftEdge(habits, [], WEDNESDAY)).toBe('2026-05-01');
  });

  it('moves to a log older than the habit\'s own createdAt', () => {
    const habits = [habit({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' })];
    const logs = [log('a', '2026-05-01')];
    expect(historyLeftEdge(habits, logs, WEDNESDAY)).toBe('2026-05-01');
  });

  it('ignores an archived habit and its logs entirely', () => {
    const habits = [
      habit({ id: 'a', createdAt: '2026-05-01T00:00:00.000Z', archivedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const logs = [log('a', '2026-04-01')];
    expect(historyLeftEdge(habits, logs, WEDNESDAY)).toBe('2026-06-16'); // back to the floor
  });

  it('ignores a not-done log', () => {
    const habits = [habit({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z' })];
    const logs = [log('a', '2026-05-01', false)];
    expect(historyLeftEdge(habits, logs, WEDNESDAY)).toBe('2026-06-16');
  });

  it('treats an epoch createdAt (missing field) as unknown, not as 1970', () => {
    const habits = [habit({ id: 'a', createdAt: new Date(0).toISOString() })];
    expect(historyLeftEdge(habits, [], WEDNESDAY)).toBe('2026-06-16');
  });

  it('still honours a log on a habit with an epoch createdAt', () => {
    const habits = [habit({ id: 'a', createdAt: new Date(0).toISOString() })];
    const logs = [log('a', '2026-05-01')];
    expect(historyLeftEdge(habits, logs, WEDNESDAY)).toBe('2026-05-01');
  });

  it('picks the earliest across several active habits', () => {
    const habits = [
      habit({ id: 'a', createdAt: '2026-06-20T00:00:00.000Z' }),
      habit({ id: 'b', createdAt: '2026-05-10T00:00:00.000Z' }),
    ];
    expect(historyLeftEdge(habits, [], WEDNESDAY)).toBe('2026-05-10');
  });

  it('respects a custom windowDays for the floor', () => {
    expect(historyLeftEdge([], [], WEDNESDAY, 7)).toBe('2026-07-09'); // 6 days back
  });
});

describe('visibleDoneCount', () => {
  const days: HistoryGridDay[] = [
    { dateKey: '2026-07-13', habitIds: ['a'] },
    { dateKey: '2026-07-14', habitIds: [] },
    { dateKey: '2026-07-15', habitIds: ['a', 'b'] },
  ];

  it('sums habitIds across the visible slice only', () => {
    expect(visibleDoneCount(days, 0, 2)).toBe(3);
    expect(visibleDoneCount(days, 1, 2)).toBe(2);
    expect(visibleDoneCount(days, 2, 2)).toBe(2);
  });

  it('is 0 for an empty slice', () => {
    expect(visibleDoneCount(days, 1, 1)).toBe(0);
  });
});

function dateKeyAt(baseYear: number, baseMonthIndex: number, baseDay: number, offset: number): string {
  const date = new Date(baseYear, baseMonthIndex, baseDay + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('historyAxis', () => {
  // 30 consecutive days, 2026-06-16 (oldest) .. 2026-07-15 (today, last).
  const days: HistoryGridDay[] = Array.from({ length: 30 }, (_, index) => ({
    dateKey: dateKeyAt(2026, 5, 16, index),
    habitIds: [],
  }));

  it('shows the relative phrase when today is the last visible day', () => {
    const axis = historyAxis({
      windowDays: 30,
      days,
      firstIndex: 0,
      lastIndex: days.length - 1,
      today: '2026-07-15',
      doneCount: 5,
    });
    expect(axis).toEqual({
      leftLabel: 'vor 30 Tagen',
      rightLabel: 'heute',
      ariaLabel: '5 Erledigungen in den letzten 30 Tagen',
    });
  });

  it('shows the weekly relative phrase for a 7-day window', () => {
    const axis = historyAxis({
      windowDays: 7,
      days,
      firstIndex: days.length - 7,
      lastIndex: days.length - 1,
      today: '2026-07-15',
      doneCount: 2,
    });
    expect(axis.leftLabel).toBe('vor 1 Woche');
    expect(axis.ariaLabel).toBe('2 Erledigungen in der letzten Woche');
  });

  it('shows a date range once today scrolls out of view', () => {
    const axis = historyAxis({
      windowDays: 30,
      days,
      firstIndex: 0,
      lastIndex: 5,
      today: '2026-07-15',
      doneCount: 3,
    });
    expect(axis).toEqual({
      leftLabel: '16. Juni',
      rightLabel: '21. Juni',
      ariaLabel: '3 Erledigungen vom 16. Juni bis 21. Juni',
    });
  });

  it('adds the year to a date-range label outside the current year', () => {
    const pastYearDays: HistoryGridDay[] = [
      { dateKey: '2025-12-20', habitIds: [] },
      { dateKey: '2025-12-21', habitIds: [] },
    ];
    const axis = historyAxis({
      windowDays: 30,
      days: pastYearDays,
      firstIndex: 0,
      lastIndex: 1,
      today: '2026-07-15',
      doneCount: 0,
    });
    expect(axis.leftLabel).toBe('20. Dez. 2025');
    expect(axis.rightLabel).toBe('21. Dez. 2025');
  });
});
