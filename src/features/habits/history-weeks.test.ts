import { describe, expect, it } from 'vitest';
import { historyWeeks } from './history-weeks';
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

// A Wednesday, running week 2026-07-13..2026-07-19 (Mon–Sun) — same reference as streak.test.ts.
const WEDNESDAY = '2026-07-15';

describe('historyWeeks (issue #863)', () => {
  it('daily mit 5 von 7 Tagen in der laufenden Woche → ratio 5/7', () => {
    const logs = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'].map((day) =>
      log(day),
    );
    const bars = historyWeeks(daily(), logs, WEDNESDAY);
    expect(bars.at(-1)!.ratio).toBeCloseTo(5 / 7);
  });

  it('leere Wochen → ratio 0', () => {
    const bars = historyWeeks(daily(), [], WEDNESDAY);
    expect(bars.every((bar) => bar.ratio === 0)).toBe(true);
  });

  it('nur die letzte Woche ist isCurrent', () => {
    const bars = historyWeeks(daily(), [], WEDNESDAY);
    expect(bars.slice(0, -1).every((bar) => !bar.isCurrent)).toBe(true);
    expect(bars.at(-1)!.isCurrent).toBe(true);
  });

  it('Länge ist immer 12 (Default)', () => {
    expect(historyWeeks(daily(), [], WEDNESDAY)).toHaveLength(12);
  });

  it('count ist überschreibbar', () => {
    expect(historyWeeks(daily(), [], WEDNESDAY, 4)).toHaveLength(4);
  });

  it('weekly mit target 3, 2 diese Woche erledigt → ratio 2/3', () => {
    const logs = [log('2026-07-13'), log('2026-07-14')];
    const bars = historyWeeks(weekly({ target: 3 }), logs, WEDNESDAY);
    expect(bars.at(-1)!.ratio).toBeCloseTo(2 / 3);
  });

  it('monthly: jede Woche derselben laufenden Periode trägt denselben Stand', () => {
    const logs = [log('2026-07-05'), log('2026-07-10')]; // 2 von target 1 diesen Monat -> gedeckelt auf 1
    const bars = historyWeeks(monthly({ target: 1 }), logs, WEDNESDAY);
    // Die letzten beiden Wochen (07-06..07-12 und 07-13..07-19) liegen beide im Juli.
    expect(bars.at(-1)!.ratio).toBe(1);
    expect(bars.at(-2)!.ratio).toBe(1);
  });
});
