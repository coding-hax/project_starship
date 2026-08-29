import { describe, expect, it } from 'vitest';
import { monthProgress } from './month-progress';
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
const log = (dateKey: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId: 'habit-1',
  logDate: dateKey,
  done,
});

// July 2026 — 31 days, 1 July is a Wednesday, Mondays fall on 6/13/20/27.
const JULY = new Date(2026, 6, 1);

describe('monthProgress', () => {
  it('daily: due is the number of days in the month', () => {
    expect(monthProgress(habit({ schedule: 'daily' }), [], JULY).due).toBe(31);
  });

  it('daily: done counts logs inside the month', () => {
    const logs = [log('2026-07-05'), log('2026-07-20'), log('2026-06-30'), log('2026-08-01')];
    expect(monthProgress(habit({ schedule: 'daily' }), logs, JULY)).toEqual({ done: 2, due: 31 });
  });

  it('weekly: due is target times the Mondays that start inside the month', () => {
    // Mondays fully inside July 2026: 6, 13, 20, 27 → 4.
    expect(monthProgress(habit({ schedule: 'weekly', target: 2 }), [], JULY).due).toBe(8);
  });

  it('weekly: done sums logs across each of those weeks', () => {
    const logs = [log('2026-07-06'), log('2026-07-07'), log('2026-07-14')];
    expect(monthProgress(habit({ schedule: 'weekly', target: 2 }), logs, JULY)).toEqual({
      done: 3,
      due: 8,
    });
  });

  it('monthly: due is 1, done counts logs anywhere in the month', () => {
    const logs = [log('2026-07-10')];
    expect(monthProgress(habit({ schedule: 'monthly' }), logs, JULY)).toEqual({ done: 1, due: 1 });
  });

  it('a period that started the previous month does not count toward this month', () => {
    // The Mon–Sun week of 2026-06-29..2026-07-05 starts in June — its Monday
    // (29 June) is outside July, so July gives it no Soll of its own.
    const logs = [log('2026-07-01')]; // inside July, but inside that carried-over week
    const result = monthProgress(habit({ schedule: 'weekly', target: 2 }), logs, JULY);
    expect(result.due).toBe(8); // unaffected by the leading partial week
  });

  it('a period starting in this month but extending past month end still counts whole', () => {
    // The week starting Monday 27 July runs into August (27 Jul–2 Aug).
    const logs = [log('2026-07-28'), log('2026-08-01')]; // both inside that same week
    const result = monthProgress(habit({ schedule: 'weekly', target: 2 }), logs, JULY);
    expect(result.done).toBe(2);
  });

  it('archived habits are still computed the same way (archiving is a caller-side filter)', () => {
    const logs = [log('2026-07-10')];
    const result = monthProgress(
      habit({ schedule: 'daily', archivedAt: '2026-07-01T00:00:00.000Z' }),
      logs,
      JULY,
    );
    expect(result).toEqual({ done: 1, due: 31 });
  });
});
