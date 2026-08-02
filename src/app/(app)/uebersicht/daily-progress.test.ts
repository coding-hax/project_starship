import { describe, expect, it } from 'vitest';
import type { HabitLogView } from '@/features/habits/use-habit-logs';
import type { HabitView } from '@/features/habits/use-habits';
import type { TaskView } from '@/features/tasks/use-tasks';
import { computeDailyProgress } from './daily-progress';

// A Wednesday, so weekly habits have a stable week window (matches
// schedule-rules.test.ts's fixture date).
const NOW = new Date('2026-07-15T12:00:00.000Z');
const YESTERDAY = new Date('2026-07-14T09:00:00.000Z');
const TOMORROW = new Date('2026-07-16T09:00:00.000Z');

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'task-1',
    title: 'Task',
    notes: null,
    dueAt: YESTERDAY.toISOString(),
    priority: 0,
    completedAt: null,
    createdAt: YESTERDAY.toISOString(),
    parentId: null,
    ...overrides,
  };
}

function habit(overrides: Partial<HabitView> = {}): HabitView {
  return {
    id: 'habit-1',
    name: 'Habit',
    schedule: 'daily',
    color: null,
    archivedAt: null,
    createdAt: YESTERDAY.toISOString(),
    ...overrides,
  };
}

function log(overrides: Partial<HabitLogView> = {}): HabitLogView {
  return { id: 'log-1', habitId: 'habit-1', logDate: '2026-07-15', done: true, ...overrides };
}

const allActive = () => true;
const onlyTasks = (id: string) => id === 'aufgaben';
const onlyHabits = (id: string) => id === 'gewohnheiten';
const noneActive = () => false;

describe('computeDailyProgress', () => {
  it('counts due-today tasks and open/done habits together', () => {
    const tasks = [
      task({ id: 't-done', completedAt: NOW.toISOString() }),
      task({ id: 't-open' }),
      task({ id: 't-future', dueAt: TOMORROW.toISOString() }), // not due today -> excluded
    ];
    const habits = [habit({ id: 'h-daily' })];
    const logs = [log({ habitId: 'h-daily', logDate: '2026-07-15', done: true })];

    expect(computeDailyProgress(tasks, habits, logs, allActive, NOW)).toEqual({
      done: 2,
      total: 3,
    });
  });

  it('excludes tasks when the Aufgaben module is off', () => {
    const tasks = [task({ completedAt: NOW.toISOString() })];
    const habits = [habit()];
    const logs = [log({ done: true, logDate: '2026-07-15' })];

    expect(computeDailyProgress(tasks, habits, logs, onlyHabits, NOW)).toEqual({
      done: 1,
      total: 1,
    });
  });

  it('excludes habits when the Gewohnheiten module is off', () => {
    const tasks = [task()];
    const habits = [habit()];
    const logs: HabitLogView[] = [];

    expect(computeDailyProgress(tasks, habits, logs, onlyTasks, NOW)).toEqual({
      done: 0,
      total: 1,
    });
  });

  it('archived habits never count, even if due', () => {
    const habits = [habit({ archivedAt: YESTERDAY.toISOString() })];
    expect(computeDailyProgress([], habits, [], onlyHabits, NOW)).toEqual({ done: 0, total: 0 });
  });

  it('a weekly habit not due this week does not count', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    // Still inside the week, so it *does* count — sanity check against schedule-rules.
    expect(computeDailyProgress([], habits, [], onlyHabits, NOW)).toEqual({ done: 0, total: 1 });
  });

  it('a weekly habit done earlier this week drops out of both counts (issue #503, AC1)', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-13', done: true })]; // Monday, earlier this week
    expect(computeDailyProgress([], habits, logs, onlyHabits, NOW)).toEqual({ done: 0, total: 0 });
  });

  it('a weekly habit done today still counts in both counts, no backwards jump (issue #503, AC2)', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-15', done: true })]; // today
    expect(computeDailyProgress([], habits, logs, onlyHabits, NOW)).toEqual({ done: 1, total: 1 });
  });

  it('a daily habit done yesterday still counts as open today (issue #503, AC4)', () => {
    const habits = [habit({ id: 'h-daily', schedule: 'daily' })];
    const logs = [log({ habitId: 'h-daily', logDate: '2026-07-14', done: true })]; // yesterday
    expect(computeDailyProgress([], habits, logs, onlyHabits, NOW)).toEqual({ done: 0, total: 1 });
  });

  it('the ring has nothing left when the only weekly habit was done earlier this week (issue #503, AC5)', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-13', done: true })];
    expect(computeDailyProgress([], habits, logs, allActive, NOW)).toEqual({ done: 0, total: 0 });
  });

  it('a new week resets a weekly habit back to open (issue #503, AC6)', () => {
    const habits = [habit({ id: 'h-weekly', schedule: 'weekly' })];
    const logs = [log({ habitId: 'h-weekly', logDate: '2026-07-06', done: true })]; // Monday of the prior week

    const sameWeekLater = new Date('2026-07-07T12:00:00.000Z'); // Tuesday, still that week -> excluded
    expect(computeDailyProgress([], habits, logs, onlyHabits, sameWeekLater)).toEqual({
      done: 0,
      total: 0,
    });

    const nextWeek = new Date('2026-07-15T12:00:00.000Z'); // Wednesday, a week later -> open again
    expect(computeDailyProgress([], habits, logs, onlyHabits, nextWeek)).toEqual({
      done: 0,
      total: 1,
    });
  });

  it('both modules off yields nothing, regardless of data', () => {
    const tasks = [task()];
    const habits = [habit()];
    const logs = [log()];
    expect(computeDailyProgress(tasks, habits, logs, noneActive, NOW)).toEqual({
      done: 0,
      total: 0,
    });
  });

  it('no data due today yields total 0', () => {
    expect(computeDailyProgress([], [], [], allActive, NOW)).toEqual({ done: 0, total: 0 });
  });
});
