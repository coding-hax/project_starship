import { describe, expect, it } from 'vitest';
import { cellHabitId, historyGrid } from './history-grid';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const habit = (overrides: Partial<HabitView> = {}): HabitView => ({
  id: 'habit-1',
  name: 'x',
  schedule: 'daily',
  target: 1,
  color: null,
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

  it('ignores a log older than the 30-day window', () => {
    const habits = [habit({ id: 'a' })];
    const logs = [log('a', '2026-06-01')]; // 44 days before WEDNESDAY
    const grid = historyGrid(habits, logs, WEDNESDAY);
    expect(grid.days.every((day) => day.habitIds.length === 0)).toBe(true);
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

describe('cellHabitId', () => {
  it('fills the bottom rows first, leaving the top rows empty (issue #1070 AC3)', () => {
    const day = { dateKey: '2026-07-15', habitIds: ['older', 'newer'] };
    // 3 active habits total → 3 rows (0 = top, 2 = bottom), only 2 done.
    expect(cellHabitId(day, 0, 3)).toBeNull(); // top row: empty
    expect(cellHabitId(day, 1, 3)).toBe('newer'); // middle row
    expect(cellHabitId(day, 2, 3)).toBe('older'); // bottom row: oldest habit
  });

  it('fills every row when every habit is done, bottom row anchored to the first entry', () => {
    const day = { dateKey: '2026-07-15', habitIds: ['a', 'b'] };
    expect(cellHabitId(day, 0, 2)).toBe('b'); // top row
    expect(cellHabitId(day, 1, 2)).toBe('a'); // bottom row: first entry
  });

  it('leaves every row empty for a day with nothing done', () => {
    const day = { dateKey: '2026-07-15', habitIds: [] };
    expect(cellHabitId(day, 0, 2)).toBeNull();
    expect(cellHabitId(day, 1, 2)).toBeNull();
  });

  it('handles a single row without dividing by an out-of-range index', () => {
    const done = { dateKey: '2026-07-15', habitIds: ['a'] };
    const empty = { dateKey: '2026-07-15', habitIds: [] };
    expect(cellHabitId(done, 0, 1)).toBe('a');
    expect(cellHabitId(empty, 0, 1)).toBeNull();
  });
});
