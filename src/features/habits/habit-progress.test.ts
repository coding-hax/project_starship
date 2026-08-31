import { describe, expect, it } from 'vitest';
import { computeHabitProgress } from './habit-progress';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

// A Wednesday, so weekly habits have a stable week window (matches
// daily-progress.test.ts / schedule-rules.test.ts's fixture date).
const NOW = new Date('2026-07-15T12:00:00.000Z');
const YESTERDAY = new Date('2026-07-14T09:00:00.000Z');

function habit(overrides: Partial<HabitView> = {}): HabitView {
  return {
    id: 'habit-1',
    name: 'Habit',
    schedule: 'daily',
    target: 1,
    color: null,
    archivedAt: null,
    createdAt: YESTERDAY.toISOString(),
    ...overrides,
  };
}

function log(overrides: Partial<HabitLogView> = {}): HabitLogView {
  return { id: 'log-1', habitId: 'habit-1', logDate: '2026-07-15', done: true, ...overrides };
}

describe('computeHabitProgress', () => {
  it('counts due-today habits, open and done together', () => {
    const habits = [habit({ id: 'h-open' }), habit({ id: 'h-done' })];
    const logs = [log({ habitId: 'h-done', logDate: '2026-07-15', done: true })];

    expect(computeHabitProgress(habits, logs, NOW)).toEqual({ done: 1, total: 2 });
  });

  it('archived habits never count, even if otherwise due', () => {
    const habits = [habit({ archivedAt: YESTERDAY.toISOString() })];
    expect(computeHabitProgress(habits, [], NOW)).toEqual({ done: 0, total: 0 });
  });

  it('a weekly habit met earlier this week drops out of both counts', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-13', done: true })]; // Monday, earlier this week
    expect(computeHabitProgress(habits, logs, NOW)).toEqual({ done: 0, total: 0 });
  });

  it('a weekly habit done today still counts in both counts, no backwards jump', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-15', done: true })]; // today
    expect(computeHabitProgress(habits, logs, NOW)).toEqual({ done: 1, total: 1 });
  });

  it('no habits due yields total 0', () => {
    expect(computeHabitProgress([], [], NOW)).toEqual({ done: 0, total: 0 });
  });
});
