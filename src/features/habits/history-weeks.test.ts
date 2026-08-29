import { describe, expect, it } from 'vitest';
import { historyWeeks } from './history-weeks';
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

// A Wednesday inside the Mon–Sun week 2026-07-13..2026-07-19 — same reference
// week as schedule-rules.test.ts/streak.test.ts.
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

describe('historyWeeks', () => {
  it('returns 12 entries', () => {
    expect(historyWeeks(habit(), [], WEDNESDAY)).toHaveLength(12);
  });

  it('daily: due is always 7, done counts that week\'s logs', () => {
    const logs = [
      ...'2026-07-13,2026-07-14,2026-07-15,2026-07-16,2026-07-17,2026-07-18,2026-07-19'
        .split(',')
        .map((day) => log(day)), // every day this week
      log('2026-07-06'), // one day last week
    ];
    const entries = historyWeeks(habit({ schedule: 'daily' }), logs, WEDNESDAY);
    expect(entries.every((entry) => entry.due === 7)).toBe(true);
    expect(entries.at(-1)).toEqual({ done: 7, due: 7 }); // this week
    expect(entries.at(-2)).toEqual({ done: 1, due: 7 }); // last week
    expect(entries.at(-3)).toEqual({ done: 0, due: 7 }); // two weeks ago
  });

  it('weekly: due is the habit\'s target, done counts that week\'s logs', () => {
    const logs = [log('2026-07-14'), log('2026-07-15'), log('2026-07-07')];
    const entries = historyWeeks(habit({ schedule: 'weekly', target: 2 }), logs, WEDNESDAY);
    expect(entries.every((entry) => entry.due === 2)).toBe(true);
    expect(entries.at(-1)).toEqual({ done: 2, due: 2 }); // this week: two logs
    expect(entries.at(-2)).toEqual({ done: 1, due: 2 }); // last week: one log
  });

  it('biweekly: the same fortnight repeats its {done, due} across both weeks it spans', () => {
    // Same reference fortnight as schedule-rules.test.ts: ISO weeks 1+2 of
    // 2026 pair into 2025-12-29..2026-01-11.
    const wednesdayInWeek2 = new Date(2026, 0, 7, 12, 0, 0);
    const logs = [log('2026-01-03')]; // inside the fortnight
    const entries = historyWeeks(habit({ schedule: 'biweekly' }), logs, wednesdayInWeek2);
    expect(entries.at(-1)).toEqual({ done: 1, due: 1 }); // week of 2026-01-05
    expect(entries.at(-2)).toEqual({ done: 1, due: 1 }); // week of 2025-12-29, same fortnight
    expect(entries.at(-3)).toEqual({ done: 0, due: 1 }); // earlier fortnight, untouched
  });

  it('no logs → every entry done 0', () => {
    const entries = historyWeeks(habit({ schedule: 'weekly', target: 3 }), [], WEDNESDAY);
    expect(entries.every((entry) => entry.done === 0 && entry.due === 3)).toBe(true);
  });
});
