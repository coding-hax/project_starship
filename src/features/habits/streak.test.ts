import { describe, expect, it } from 'vitest';
import { computeStreak } from './streak';
import type { HabitFreezeView } from './use-habit-freezes';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const daily = (overrides: Partial<HabitView> = {}): HabitView => ({
  id: 'habit-1',
  name: 'x',
  schedule: 'daily',
  color: null,
  archivedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

const weekly = (overrides: Partial<HabitView> = {}): HabitView => daily({ schedule: 'weekly', ...overrides });

let logId = 0;
const log = (dateKey: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId: 'habit-1',
  logDate: dateKey,
  done,
});

let freezeId = 0;
const freeze = (dateKey: string): HabitFreezeView => ({
  id: `freeze-${freezeId++}`,
  habitId: 'habit-1',
  freezeDate: dateKey,
});

// A Wednesday, same reference date as due-today.test.ts (2026-07-15).
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('computeStreak — daily', () => {
  it('3 consecutive days including today → streak 3', () => {
    const logs = [log('2026-07-15'), log('2026-07-14'), log('2026-07-13')];
    expect(computeStreak(daily(), logs, [], WEDNESDAY)).toBe(3);
  });

  it('a skipped day breaks the streak at zero', () => {
    const logs = [log('2026-07-13')]; // gap on the 14th
    expect(computeStreak(daily(), logs, [], WEDNESDAY)).toBe(0);
  });

  it('today still open does not break the streak, as long as yesterday is done', () => {
    const logs = [log('2026-07-14'), log('2026-07-13')]; // today (15th) not logged yet
    expect(computeStreak(daily(), logs, [], WEDNESDAY)).toBe(2);
  });

  it('a day skipped and now it is tomorrow → the streak is gone', () => {
    // Yesterday (14th) was skipped; "now" has moved on to the 15th.
    const logs = [log('2026-07-13')];
    expect(computeStreak(daily(), logs, [], WEDNESDAY)).toBe(0);
  });

  it('an untouched habit has streak 0', () => {
    expect(computeStreak(daily(), [], [], WEDNESDAY)).toBe(0);
  });

  it('a done=false log does not count as done', () => {
    const logs = [log('2026-07-15', false)];
    expect(computeStreak(daily(), logs, [], WEDNESDAY)).toBe(0);
  });

  it('a freeze bridges a gap, the streak keeps running (issue #433)', () => {
    // 13th done, 14th skipped but frozen, 15th (today) done.
    const logs = [log('2026-07-15'), log('2026-07-13')];
    const freezes = [freeze('2026-07-14')];
    expect(computeStreak(daily(), logs, freezes, WEDNESDAY)).toBe(3);
  });

  it('a freeze on a day that was not a gap changes nothing', () => {
    const logs = [log('2026-07-15'), log('2026-07-14'), log('2026-07-13')];
    const freezes = [freeze('2026-07-14')];
    expect(computeStreak(daily(), logs, freezes, WEDNESDAY)).toBe(3);
  });
});

describe('computeStreak — weekly', () => {
  it('done this week and last week → streak 2', () => {
    const logs = [log('2026-07-14'), log('2026-07-07')]; // this week + last week (Mon–Sun)
    expect(computeStreak(weekly(), logs, [], WEDNESDAY)).toBe(2);
  });

  it('a skipped week resets the streak', () => {
    // Done this week and two weeks ago, but not last week — the gap resets it.
    const logs = [log('2026-07-14'), log('2026-06-30')];
    expect(computeStreak(weekly(), logs, [], WEDNESDAY)).toBe(1);
  });

  it('the running week not done yet does not break the streak, if last week is done', () => {
    const logs = [log('2026-07-07')]; // last week only, nothing this week yet
    expect(computeStreak(weekly(), logs, [], WEDNESDAY)).toBe(1);
  });

  it('an untouched habit has streak 0', () => {
    expect(computeStreak(weekly(), [], [], WEDNESDAY)).toBe(0);
  });

  it('weekly ignores freezes entirely', () => {
    // Last week skipped, but "frozen" — a freeze must not resurrect a weekly streak.
    const logs = [log('2026-07-14')]; // this week only
    const freezes = [freeze('2026-07-10')]; // inside last week's range
    expect(computeStreak(weekly(), logs, freezes, WEDNESDAY)).toBe(1);
  });
});
