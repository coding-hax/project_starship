import { describe, expect, it } from 'vitest';
import { isDoneInWeek, isDoneOnDay, isDueOnDay, weekRangeForDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';

function log(overrides: Partial<HabitLogView> = {}): HabitLogView {
  return { id: 'log', habitId: 'habit-1', logDate: '2026-07-15', done: true, ...overrides };
}

describe('weekRangeForDay', () => {
  it('a Wednesday falls in the Mon–Sun week starting that Monday', () => {
    expect(weekRangeForDay('2026-07-15')).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('a Sunday is the last day of its own week, not the next one', () => {
    expect(weekRangeForDay('2026-07-19')).toEqual({ start: '2026-07-13', end: '2026-07-19' });
  });

  it('the following Monday starts a new week', () => {
    expect(weekRangeForDay('2026-07-20')).toEqual({ start: '2026-07-20', end: '2026-07-26' });
  });

  it('crosses a month boundary correctly', () => {
    expect(weekRangeForDay('2026-08-01')).toEqual({ start: '2026-07-27', end: '2026-08-02' });
  });
});

describe('isDueOnDay', () => {
  const week = { start: '2026-07-13', end: '2026-07-19' };

  it('daily is due every day', () => {
    expect(isDueOnDay({ schedule: 'daily' }, '2026-07-15', week)).toBe(true);
  });

  it('custom has no due-logic yet — treated like daily', () => {
    expect(isDueOnDay({ schedule: 'custom' }, '2026-07-15', week)).toBe(true);
  });

  it('weekly is due on any day inside its week', () => {
    expect(isDueOnDay({ schedule: 'weekly' }, '2026-07-13', week)).toBe(true);
    expect(isDueOnDay({ schedule: 'weekly' }, '2026-07-19', week)).toBe(true);
  });

  it('weekly is not due outside the given week range', () => {
    expect(isDueOnDay({ schedule: 'weekly' }, '2026-07-20', week)).toBe(false);
  });
});

describe('isDoneOnDay', () => {
  it('true only for a done log on the exact day for that habit', () => {
    const logs = [log({ logDate: '2026-07-15' })];
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-15')).toBe(true);
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-16')).toBe(false);
    expect(isDoneOnDay(logs, 'other-habit', '2026-07-15')).toBe(false);
  });

  it('an undone log does not count', () => {
    const logs = [log({ done: false })];
    expect(isDoneOnDay(logs, 'habit-1', '2026-07-15')).toBe(false);
  });
});

describe('isDoneInWeek', () => {
  const week = { start: '2026-07-13', end: '2026-07-19' };

  it('true for a done log anywhere inside the range', () => {
    expect(isDoneInWeek([log({ logDate: '2026-07-14' })], 'habit-1', week)).toBe(true);
  });

  it('false for a done log outside the range', () => {
    expect(isDoneInWeek([log({ logDate: '2026-07-20' })], 'habit-1', week)).toBe(false);
  });

  it('false when nothing is done for that habit', () => {
    expect(isDoneInWeek([log({ done: false })], 'habit-1', week)).toBe(false);
  });
});
