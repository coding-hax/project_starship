import { describe, expect, it, vi } from 'vitest';
import { habitFreezes, habits, type Habit, type HabitFreeze, type HabitLog } from '@/db/schema';

let habitRows: Habit[] = [];
let logRows: HabitLog[] = [];
const freezeRows: HabitFreeze[] = [];

vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(
            table === habits ? habitRows : table === habitFreezes ? freezeRows : logRows,
          ),
      }),
    }),
  },
}));

import { build, selectOpenHabits } from './habits-open';

// 20:05 Berlin (CEST, UTC+2) on 2026-07-15 (a Wednesday).
const AT_2005_BERLIN = new Date(Date.UTC(2026, 6, 15, 18, 5));

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    updatedAt: new Date(),
    deletedAt: null,
    syncedAt: null,
    syncSeq: 1,
    name: 'Laufen',
    schedule: 'daily',
    target: 1,
    color: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function log(overrides: Partial<HabitLog> = {}): HabitLog {
  return {
    id: 'log-1',
    updatedAt: new Date(),
    deletedAt: null,
    syncedAt: null,
    syncSeq: 1,
    habitId: 'habit-1',
    logDate: '2026-07-15',
    done: true,
    ...overrides,
  };
}

describe('selectOpenHabits', () => {
  it('a daily habit not yet done today is open', () => {
    const open = selectOpenHabits([habit()], [], [], '2026-07-15');
    expect(open).toEqual([{ name: 'Laufen', streak: 0 }]);
  });

  it('a daily habit already done today is not open', () => {
    const open = selectOpenHabits([habit()], [log()], [], '2026-07-15');
    expect(open).toEqual([]);
  });

  // The Journal habit (issue #505) is a plain `habits` row, recognized elsewhere
  // only by a fixed id — no special-casing here (AC6), so it shows up (or not)
  // exactly like any other daily habit.
  it('a not-yet-written Journal habit shows up like any other open habit', () => {
    const journal = habit({ name: 'Journal' });
    expect(selectOpenHabits([journal], [], [], '2026-07-15')).toEqual([
      { name: 'Journal', streak: 0 },
    ]);
  });

  it('a weekly habit is never in the reminder window before the last day of its week (issue #509 Owner-Entsch. 2)', () => {
    const weekly = habit({ id: 'habit-2', schedule: 'weekly' });
    // Wednesday — the week only ends on Sunday (2026-07-19).
    expect(selectOpenHabits([weekly], [], [], '2026-07-15')).toEqual([]);
  });

  it('a weekly habit done earlier this week is not open on the last day of the week', () => {
    const weekly = habit({ id: 'habit-2', schedule: 'weekly' });
    const doneMonday = log({ habitId: 'habit-2', logDate: '2026-07-13' });
    expect(selectOpenHabits([weekly], [doneMonday], [], '2026-07-19')).toEqual([]);
  });

  it('a weekly habit not done at all is open on the last day of the week', () => {
    const weekly = habit({ id: 'habit-2', schedule: 'weekly' });
    expect(selectOpenHabits([weekly], [], [], '2026-07-19')).toEqual([{ name: 'Laufen', streak: 0 }]);
  });

  it('a "3x pro Woche" habit with only 2 done is still open on the last day of the week', () => {
    const weekly = habit({ id: 'habit-2', schedule: 'weekly', target: 3 });
    const logs = [
      log({ habitId: 'habit-2', logDate: '2026-07-13' }),
      log({ habitId: 'habit-2', logDate: '2026-07-14' }),
    ];
    expect(selectOpenHabits([weekly], logs, [], '2026-07-19')).toEqual([{ name: 'Laufen', streak: 0 }]);
  });

  it('a "3x pro Woche" habit with all 3 done is not open on the last day of the week', () => {
    const weekly = habit({ id: 'habit-2', schedule: 'weekly', target: 3 });
    const logs = [
      log({ habitId: 'habit-2', logDate: '2026-07-13' }),
      log({ habitId: 'habit-2', logDate: '2026-07-14' }),
      log({ habitId: 'habit-2', logDate: '2026-07-15' }),
    ];
    expect(selectOpenHabits([weekly], logs, [], '2026-07-19')).toEqual([]);
  });

  it('a biweekly habit is only in the reminder window on the last day of its fortnight', () => {
    const biweekly = habit({ id: 'habit-2', schedule: 'biweekly' });
    // 2026-07-13..2026-07-26 is one fortnight (ISO week 29 pairs with 30).
    expect(selectOpenHabits([biweekly], [], [], '2026-07-15')).toEqual([]);
    expect(selectOpenHabits([biweekly], [], [], '2026-07-26')).toEqual([
      { name: 'Laufen', streak: 0 },
    ]);
  });

  it('a monthly habit is open in the last 3 days of the month, not before', () => {
    const monthly = habit({ id: 'habit-2', schedule: 'monthly' });
    expect(selectOpenHabits([monthly], [], [], '2026-07-28')).toEqual([]);
    expect(selectOpenHabits([monthly], [], [], '2026-07-29')).toEqual([
      { name: 'Laufen', streak: 0 },
    ]);
    expect(selectOpenHabits([monthly], [], [], '2026-07-31')).toEqual([
      { name: 'Laufen', streak: 0 },
    ]);
  });

  it('a yearly habit is open in the last 7 days of the year, not before', () => {
    const yearly = habit({ id: 'habit-2', schedule: 'yearly' });
    expect(selectOpenHabits([yearly], [], [], '2026-12-24')).toEqual([]);
    expect(selectOpenHabits([yearly], [], [], '2026-12-25')).toEqual([
      { name: 'Laufen', streak: 0 },
    ]);
    expect(selectOpenHabits([yearly], [], [], '2026-12-31')).toEqual([
      { name: 'Laufen', streak: 0 },
    ]);
  });

  it('the streak count is included and only counted from before today', () => {
    const streakLogs = [
      log({ logDate: '2026-07-14' }),
      log({ logDate: '2026-07-13' }),
    ];
    expect(selectOpenHabits([habit()], streakLogs, [], '2026-07-15')).toEqual([
      { name: 'Laufen', streak: 2 },
    ]);
  });
});

describe('habits-open build()', () => {
  it('returns null when there are no habits at all', async () => {
    habitRows = [];
    logRows = [];
    expect(await build(AT_2005_BERLIN)).toBeNull();
  });

  it('returns null when everything is done', async () => {
    habitRows = [habit()];
    logRows = [log()];
    expect(await build(AT_2005_BERLIN)).toBeNull();
  });

  it('archived habits never appear, even if open', async () => {
    habitRows = [habit({ archivedAt: new Date('2026-06-01') })];
    logRows = [];
    expect(await build(AT_2005_BERLIN)).toBeNull();
  });

  it('singular text, no streak suffix below 2', async () => {
    habitRows = [habit()];
    logRows = [];
    expect(await build(AT_2005_BERLIN)).toEqual({
      title: 'Noch offen',
      body: 'Laufen',
      url: '/routinen',
    });
  });

  it('the streak number appears in the text from 2 upward', async () => {
    habitRows = [habit()];
    logRows = [log({ logDate: '2026-07-14' }), log({ logDate: '2026-07-13' })];
    expect(await build(AT_2005_BERLIN)).toEqual({
      title: 'Noch offen',
      body: 'Laufen — 2 Tage in Folge',
      url: '/routinen',
    });
  });

  it('lists names and a count for several open habits', async () => {
    habitRows = [
      habit({ id: 'a', name: 'Laufen', createdAt: new Date('2026-01-01') }),
      habit({ id: 'b', name: 'Meditieren', createdAt: new Date('2026-01-02') }),
      habit({ id: 'c', name: 'Lesen', createdAt: new Date('2026-01-03') }),
    ];
    logRows = [];
    expect(await build(AT_2005_BERLIN)).toEqual({
      title: '3 Routinen heute noch offen',
      body: 'Laufen, Meditieren und 1 weitere',
      url: '/routinen',
    });
  });
});
