import { describe, expect, it } from 'vitest';
import { historyDays } from './history-days';
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

describe('historyDays', () => {
  it('returns 30 entries', () => {
    expect(historyDays([], [], WEDNESDAY)).toHaveLength(30);
  });

  it('counts habits whose streak on that day was >= 1, day by day', () => {
    const habits = [habit({ id: 'a' })];
    // A 3-day streak ending today: 13th, 14th, 15th.
    const logs = [log('a', '2026-07-13'), log('a', '2026-07-14'), log('a', '2026-07-15')];
    const entries = historyDays(habits, logs, WEDNESDAY);
    expect(entries.at(-1)).toBe(1); // today (15th): streak 3
    expect(entries.at(-2)).toBe(1); // 14th: streak 2
    expect(entries.at(-3)).toBe(1); // 13th: streak 1
    expect(entries.at(-4)).toBe(0); // 12th: no streak yet
  });

  it('the last entry is the current day\'s countHabitsOnStreak', () => {
    const habits = [habit({ id: 'a' }), habit({ id: 'b' })];
    const logs = [log('a', '2026-07-15')]; // only "a" has a streak today
    const entries = historyDays(habits, logs, WEDNESDAY);
    expect(entries.at(-1)).toBe(1);
  });

  it('no habits → every entry 0', () => {
    expect(historyDays([], [], WEDNESDAY).every((value) => value === 0)).toBe(true);
  });
});
