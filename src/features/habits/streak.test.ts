import { describe, expect, it } from 'vitest';
import { computeStreak, countHabitsOnStreak } from './streak';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

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
const log = (dateKey: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId: 'habit-1',
  logDate: dateKey,
  done,
});

// A Wednesday, same reference date as due-today.test.ts (2026-07-15).
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('computeStreak — daily', () => {
  it('3 consecutive days including today → streak 3', () => {
    const logs = [log('2026-07-15'), log('2026-07-14'), log('2026-07-13')];
    expect(computeStreak(daily(), logs, WEDNESDAY)).toBe(3);
  });

  it('a skipped day breaks the streak at zero', () => {
    const logs = [log('2026-07-13')]; // gap on the 14th
    expect(computeStreak(daily(), logs, WEDNESDAY)).toBe(0);
  });

  it('today still open does not break the streak, as long as yesterday is done', () => {
    const logs = [log('2026-07-14'), log('2026-07-13')]; // today (15th) not logged yet
    expect(computeStreak(daily(), logs, WEDNESDAY)).toBe(2);
  });

  it('a day skipped and now it is tomorrow → the streak is gone', () => {
    // Yesterday (14th) was skipped; "now" has moved on to the 15th.
    const logs = [log('2026-07-13')];
    expect(computeStreak(daily(), logs, WEDNESDAY)).toBe(0);
  });

  it('an untouched habit has streak 0', () => {
    expect(computeStreak(daily(), [], WEDNESDAY)).toBe(0);
  });

  it('a done=false log does not count as done', () => {
    const logs = [log('2026-07-15', false)];
    expect(computeStreak(daily(), logs, WEDNESDAY)).toBe(0);
  });
});

describe('computeStreak — weekly', () => {
  it('done this week and last week → streak 2', () => {
    const logs = [log('2026-07-14'), log('2026-07-07')]; // this week + last week (Mon–Sun)
    expect(computeStreak(weekly(), logs, WEDNESDAY)).toBe(2);
  });

  it('a skipped week resets the streak', () => {
    // Done this week and two weeks ago, but not last week — the gap resets it.
    const logs = [log('2026-07-14'), log('2026-06-30')];
    expect(computeStreak(weekly(), logs, WEDNESDAY)).toBe(1);
  });

  it('the running week not done yet does not break the streak, if last week is done', () => {
    const logs = [log('2026-07-07')]; // last week only, nothing this week yet
    expect(computeStreak(weekly(), logs, WEDNESDAY)).toBe(1);
  });

  it('an untouched habit has streak 0', () => {
    expect(computeStreak(weekly(), [], WEDNESDAY)).toBe(0);
  });

  it('just this week done, nothing earlier → streak 1', () => {
    const logs = [log('2026-07-14')]; // this week only
    expect(computeStreak(weekly(), logs, WEDNESDAY)).toBe(1);
  });

  it('a "3x pro Woche" target only counts a week once all 3 are done', () => {
    // This week: only 2 done, so it does not count yet — streak counts back
    // from the last fully-met week (last week, with 3 done).
    const logs = [
      log('2026-07-14'),
      log('2026-07-15'),
      log('2026-07-06'),
      log('2026-07-07'),
      log('2026-07-08'),
    ];
    expect(computeStreak(weekly({ target: 3 }), logs, WEDNESDAY)).toBe(1);
  });
});

describe('countHabitsOnStreak (issue #809)', () => {
  it('keine Routinen → 0', () => {
    expect(countHabitsOnStreak([], [], WEDNESDAY)).toBe(0);
  });

  it('eine mit, eine ohne laufende Serie → 1', () => {
    const habits = [daily({ id: 'a' }), daily({ id: 'b' })];
    const logs = [{ ...log('2026-07-15'), habitId: 'a' }];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY)).toBe(1);
  });

  it('archivierte Routine mit laufender Serie zählt nicht', () => {
    const habits = [daily({ id: 'a', archivedAt: '2026-07-10T00:00:00.000Z' })];
    const logs = [{ ...log('2026-07-15'), habitId: 'a' }];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY)).toBe(0);
  });

  it('gemischte Schedules mit je laufender Serie zählen alle', () => {
    const habits = [daily({ id: 'a' }), weekly({ id: 'b' }), monthly({ id: 'c' })];
    const logs = [
      { ...log('2026-07-15'), habitId: 'a' }, // daily: heute erledigt
      { ...log('2026-07-14'), habitId: 'b' }, // weekly: diese Woche erledigt
      { ...log('2026-07-10'), habitId: 'c' }, // monthly: diesen Monat erledigt
    ];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY)).toBe(3);
  });

  it('laufende, noch offene Periode zählt, wenn die Vorperiode erledigt war (Serie ≥ 1)', () => {
    const habits = [weekly({ id: 'a' })];
    const logs = [{ ...log('2026-07-07'), habitId: 'a' }]; // nur letzte Woche, diese Woche noch offen
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY)).toBe(1);
  });

  it('ein done:false-Log zählt nicht als Serie', () => {
    const habits = [daily({ id: 'a' })];
    const logs = [{ ...log('2026-07-15', false), habitId: 'a' }];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY)).toBe(0);
  });
});

describe('countHabitsOnStreak — minStreak (issue #1005)', () => {
  it('Serie 1 zählt nicht bei minStreak 2', () => {
    const habits = [daily({ id: 'a' })];
    const logs = [{ ...log('2026-07-15'), habitId: 'a' }]; // nur heute -> Serie 1
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY, 2)).toBe(0);
  });

  it('Serie 2 zählt bei minStreak 2', () => {
    const habits = [daily({ id: 'a' })];
    const logs = [
      { ...log('2026-07-15'), habitId: 'a' },
      { ...log('2026-07-14'), habitId: 'a' },
    ];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY, 2)).toBe(1);
  });

  it('archivierte Routine mit Serie 2 zählt nicht', () => {
    const habits = [daily({ id: 'a', archivedAt: '2026-07-10T00:00:00.000Z' })];
    const logs = [
      { ...log('2026-07-15'), habitId: 'a' },
      { ...log('2026-07-14'), habitId: 'a' },
    ];
    expect(countHabitsOnStreak(habits, logs, WEDNESDAY, 2)).toBe(0);
  });

  it('wöchentliche Routine zählt erst ab zwei erfüllten Wochen', () => {
    const habits = [weekly({ id: 'a' })];
    const logsOneWeek = [{ ...log('2026-07-07'), habitId: 'a' }]; // nur letzte Woche -> Serie 1
    expect(countHabitsOnStreak(habits, logsOneWeek, WEDNESDAY, 2)).toBe(0);

    const logsTwoWeeks = [
      { ...log('2026-07-07'), habitId: 'a' },
      { ...log('2026-06-30'), habitId: 'a' },
    ]; // zwei Wochen in Folge -> Serie 2
    expect(countHabitsOnStreak(habits, logsTwoWeeks, WEDNESDAY, 2)).toBe(1);
  });
});

describe('computeStreak — monthly (issue #509)', () => {
  it('done this month and last month → streak 2', () => {
    const logs = [log('2026-07-10'), log('2026-06-05')];
    expect(computeStreak(monthly(), logs, WEDNESDAY)).toBe(2);
  });

  it('the running month not done yet does not break the streak (issue #104)', () => {
    const logs = [log('2026-06-05')]; // last month only, nothing this month yet
    expect(computeStreak(monthly(), logs, WEDNESDAY)).toBe(1);
  });

  it('a skipped month resets the streak', () => {
    const logs = [log('2026-07-10'), log('2026-05-05')]; // June skipped
    expect(computeStreak(monthly(), logs, WEDNESDAY)).toBe(1);
  });

  it('an untouched habit has streak 0', () => {
    expect(computeStreak(monthly(), [], WEDNESDAY)).toBe(0);
  });
});
