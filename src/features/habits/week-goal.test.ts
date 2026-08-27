import { describe, expect, it } from 'vitest';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';
import { weekGoal } from './week-goal';

const daily = (overrides: Partial<HabitView> = {}): HabitView => ({
  id: 'habit-1',
  name: 'x',
  schedule: 'daily',
  target: 1,
  color: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

const weekly = (overrides: Partial<HabitView> = {}): HabitView => daily({ schedule: 'weekly', ...overrides });
const monthly = (overrides: Partial<HabitView> = {}): HabitView => daily({ schedule: 'monthly', ...overrides });

let logId = 0;
const log = (habitId: string, dateKey: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId,
  logDate: dateKey,
  done,
});

// A Wednesday, running week 2026-07-13..2026-07-19 (Mon–Sun) — same reference as streak.test.ts.
const WEDNESDAY = '2026-07-15';

describe('weekGoal (issue #863)', () => {
  it('keine Routinen → {0, 0}', () => {
    expect(weekGoal([], [], WEDNESDAY)).toEqual({ done: 0, goal: 0 });
  });

  it('nur eine monatliche Routine → goal 0, sie zählt nicht mit', () => {
    const habits = [monthly({ id: 'a' })];
    const logs = [log('a', '2026-07-10')];
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 0, goal: 0 });
  });

  it('daily 7-fach in der Woche abgehakt wird auf das Wochensoll gedeckelt', () => {
    const habits = [daily({ id: 'a' })];
    const logs = [
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20', // außerhalb der Woche, zählt nicht
    ].map((day) => log('a', day));
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 7, goal: 7 });
  });

  it('weekly mit target 3, 2 erledigt → done 2, goal 3', () => {
    const habits = [weekly({ id: 'a', target: 3 })];
    const logs = [log('a', '2026-07-13'), log('a', '2026-07-14')];
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 2, goal: 3 });
  });

  it('Mischung daily + weekly + monthly summiert nur die wochenbasierten', () => {
    const habits = [
      daily({ id: 'a' }),
      weekly({ id: 'b', target: 2 }),
      monthly({ id: 'c' }),
    ];
    const logs = [log('a', '2026-07-15'), log('b', '2026-07-13'), log('c', '2026-07-05')];
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 2, goal: 9 });
  });

  it('archivierte Routinen zählen nicht mit', () => {
    const habits = [daily({ id: 'a', archivedAt: '2026-07-10T00:00:00.000Z' })];
    const logs = [log('a', '2026-07-15')];
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 0, goal: 0 });
  });

  it('done wird pro Routine auf ihr eigenes Wochensoll gedeckelt, nicht auf die Summe', () => {
    const habits = [daily({ id: 'a' }), weekly({ id: 'b', target: 1 })];
    const logs = [
      log('a', '2026-07-13'),
      log('a', '2026-07-14'),
      log('a', '2026-07-15'),
      log('a', '2026-07-16'),
      log('a', '2026-07-17'),
      log('a', '2026-07-18'),
      log('a', '2026-07-19'),
      log('a', '2026-07-20'), // außerhalb der Woche
      log('b', '2026-07-13'),
    ];
    expect(weekGoal(habits, logs, WEDNESDAY)).toEqual({ done: 8, goal: 8 });
  });
});
