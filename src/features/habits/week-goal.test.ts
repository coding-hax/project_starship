import { describe, expect, it } from 'vitest';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';
import { weekDone, weekGoal } from './week-goal';

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

// A Wednesday inside the Mon–Sun week 2026-07-13..2026-07-19.
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('weekGoal', () => {
  it('daily counts 7', () => {
    expect(weekGoal([habit({ schedule: 'daily' })])).toBe(7);
  });

  it('custom counts 7, same day-based grouping as streak.ts', () => {
    expect(weekGoal([habit({ schedule: 'custom' })])).toBe(7);
  });

  it('weekly counts its own target', () => {
    expect(weekGoal([habit({ schedule: 'weekly', target: 3 })])).toBe(3);
  });

  it('biweekly and longer periods count 0', () => {
    expect(
      weekGoal([
        habit({ id: 'a', schedule: 'biweekly' }),
        habit({ id: 'b', schedule: 'monthly' }),
        habit({ id: 'c', schedule: 'quarterly' }),
        habit({ id: 'd', schedule: 'yearly' }),
      ]),
    ).toBe(0);
  });

  it('archived habits do not count', () => {
    expect(weekGoal([habit({ schedule: 'daily', archivedAt: '2026-07-01T00:00:00.000Z' })])).toBe(0);
  });

  it('sums across a mix of habits', () => {
    const habits = [
      habit({ id: 'a', schedule: 'daily' }),
      habit({ id: 'b', schedule: 'weekly', target: 2 }),
      habit({ id: 'c', schedule: 'monthly' }),
    ];
    expect(weekGoal(habits)).toBe(9);
  });

  it('no habits → 0', () => {
    expect(weekGoal([])).toBe(0);
  });
});

describe('weekDone', () => {
  it('counts done logs inside the current Mon–Sun week', () => {
    const habits = [habit({ id: 'a', schedule: 'daily' })];
    const logs = [log('a', '2026-07-14'), log('a', '2026-07-15')];
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(2);
  });

  it('ignores logs outside the current week', () => {
    const habits = [habit({ id: 'a', schedule: 'daily' })];
    const logs = [log('a', '2026-07-06')]; // last week
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(0);
  });

  it('ignores done:false logs', () => {
    const habits = [habit({ id: 'a', schedule: 'daily' })];
    const logs = [log('a', '2026-07-14', false)];
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(0);
  });

  it('a biweekly habit never contributes, even with a log this week', () => {
    const habits = [habit({ id: 'a', schedule: 'biweekly' })];
    const logs = [log('a', '2026-07-14')];
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(0);
  });

  it('an archived habit never contributes', () => {
    const habits = [habit({ id: 'a', schedule: 'daily', archivedAt: '2026-07-01T00:00:00.000Z' })];
    const logs = [log('a', '2026-07-14')];
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(0);
  });

  it('sums across multiple counted habits', () => {
    const habits = [habit({ id: 'a', schedule: 'daily' }), habit({ id: 'b', schedule: 'weekly', target: 3 })];
    const logs = [log('a', '2026-07-14'), log('b', '2026-07-13'), log('b', '2026-07-15')];
    expect(weekDone(habits, logs, WEDNESDAY)).toBe(3);
  });
});
