import { describe, expect, it } from 'vitest';
import { canRescue, currentStreakUsesFreeze, gapDay, monthKey, remainingJokers } from './freeze';
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

// A Wednesday, same reference date as streak.test.ts (2026-07-15).
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('gapDay / monthKey', () => {
  it('gapDay is always exactly yesterday', () => {
    expect(gapDay(WEDNESDAY)).toBe('2026-07-14');
  });

  it('monthKey takes the YYYY-MM prefix', () => {
    expect(monthKey('2026-07-14')).toBe('2026-07');
  });
});

describe('remainingJokers', () => {
  it('full quota with no freezes yet', () => {
    expect(remainingJokers([], 'habit-1', '2026-07')).toBe(2);
  });

  it('one spent this month leaves one', () => {
    expect(remainingJokers([freeze('2026-07-05')], 'habit-1', '2026-07')).toBe(1);
  });

  it('quota exhausted at two spent this month', () => {
    const freezes = [freeze('2026-07-05'), freeze('2026-07-10')];
    expect(remainingJokers(freezes, 'habit-1', '2026-07')).toBe(0);
  });

  it('a freeze in a different month does not count against this one', () => {
    expect(remainingJokers([freeze('2026-06-30')], 'habit-1', '2026-07')).toBe(2);
  });
});

describe('canRescue', () => {
  it('weekly habits can never be rescued', () => {
    const logs = [log('2026-07-13')]; // gap on the 14th
    expect(canRescue(weekly(), logs, [], WEDNESDAY)).toBe(false);
  });

  it('no gap on the day before → false', () => {
    const logs = [log('2026-07-14'), log('2026-07-13')];
    expect(canRescue(daily(), logs, [], WEDNESDAY)).toBe(false);
  });

  it('quota exhausted this month → false even with a genuine gap', () => {
    const logs = [log('2026-07-13')]; // gap on the 14th
    const freezes = [freeze('2026-07-01'), freeze('2026-07-02')]; // 2 already spent in July
    expect(canRescue(daily(), logs, freezes, WEDNESDAY)).toBe(false);
  });

  it('a freeze from a different month does not eat into this month quota', () => {
    const logs = [log('2026-07-13')]; // gap on the 14th
    const freezes = [freeze('2026-06-05'), freeze('2026-06-10')];
    expect(canRescue(daily(), logs, freezes, WEDNESDAY)).toBe(true);
  });

  it('resulting streak below 2 → false (no streak to reconnect)', () => {
    // Nothing done at all, today still open — freezing the 14th alone would
    // only reach a streak of 1, not the 2 a "reconnect" requires.
    const logs: HabitLogView[] = [];
    expect(canRescue(daily(), logs, [], WEDNESDAY)).toBe(false);
  });

  it('happy path: prior streak + gap + quota + reconnect ≥ 2 → true', () => {
    const logs = [log('2026-07-15'), log('2026-07-13'), log('2026-07-12')];
    expect(canRescue(daily(), logs, [], WEDNESDAY)).toBe(true);
  });
});

describe('currentStreakUsesFreeze', () => {
  it('false for a streak with no frozen day', () => {
    const logs = [log('2026-07-15'), log('2026-07-14'), log('2026-07-13')];
    expect(currentStreakUsesFreeze(daily(), logs, [], WEDNESDAY)).toBe(false);
  });

  it('true once the running streak includes a frozen day', () => {
    const logs = [log('2026-07-15'), log('2026-07-13')];
    const freezes = [freeze('2026-07-14')];
    expect(currentStreakUsesFreeze(daily(), logs, freezes, WEDNESDAY)).toBe(true);
  });

  it('weekly never qualifies', () => {
    const logs = [log('2026-07-14')];
    const freezes = [freeze('2026-07-10')];
    expect(currentStreakUsesFreeze(weekly(), logs, freezes, WEDNESDAY)).toBe(false);
  });
});
