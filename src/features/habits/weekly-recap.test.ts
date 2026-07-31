import { describe, expect, it } from 'vitest';
import { computeWeeklyRecap } from './weekly-recap';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const habit = (id: string, overrides: Partial<HabitView> = {}): HabitView => ({
  id,
  name: id,
  schedule: 'daily',
  color: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

let logId = 0;
const log = (habitId: string, logDate: string, done = true): HabitLogView => ({
  id: `log-${logId++}`,
  habitId,
  logDate,
  done,
});

// A Wednesday; the last fully completed Mon–Sun week is 2026-07-06..2026-07-12 (AC2).
const NOW = new Date(2026, 6, 15, 12, 0, 0);
const LAST_WEEK_DAYS = [
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  '2026-07-11',
  '2026-07-12',
];

describe('computeWeeklyRecap — AC2: Bezugswoche ist die zuletzt abgeschlossene Woche', () => {
  it('ignoriert Logs der laufenden Woche und zählt nur die Vorwoche', () => {
    const habits = [habit('a')];
    // Done every day of the running week, but not a single day last week.
    const logs = ['2026-07-13', '2026-07-14', '2026-07-15'].map((d) => log('a', d));
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 0, total: 1 });
  });
});

describe('computeWeeklyRecap — AC3: Kennzahl N von M', () => {
  it('daily: alle 7 fälligen Tage erledigt zählt als erfüllt', () => {
    const habits = [habit('a')];
    const logs = LAST_WEEK_DAYS.map((d) => log('a', d));
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 1, total: 1 });
  });

  it('daily: ein fehlender Tag zählt als nicht erfüllt', () => {
    const habits = [habit('a')];
    const logs = LAST_WEEK_DAYS.slice(0, 6).map((d) => log('a', d));
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 0, total: 1 });
  });

  it('weekly: ein einzelner Done-Log in der Woche genügt', () => {
    const habits = [habit('a', { schedule: 'weekly' })];
    const logs = [log('a', '2026-07-08')];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 1, total: 1 });
  });

  it('mehrere Gewohnheiten: nur die erfüllten zählen in N', () => {
    const habits = [
      habit('a'),
      habit('b', { schedule: 'weekly' }),
      habit('c'),
    ];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // a: erfüllt
      log('b', '2026-07-09'), // b: erfüllt
      // c: kein Log -> nicht erfüllt
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 2, total: 3 });
  });
});

describe('computeWeeklyRecap — AC4: Superlativ', () => {
  it('schlägt die einzige Vorwoche in der Historie -> "deine beste Woche"', () => {
    // createdAt so gesetzt, dass genau eine Vorwoche als Datenpunkt existiert
    // (die Woche davor liegt vor der Gründung der Gewohnheit).
    const habits = [habit('a', { createdAt: '2026-06-29T00:00:00.000Z' })];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: 7/7
      log('a', '2026-06-29'), // Vorwoche: 1/7 -> unvollständig
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'best-ever' });
  });

  it('schlägt alle >1 Vorwochen -> "beste Woche seit N Wochen"', () => {
    // createdAt begrenzt die Historie auf genau zwei Vorwochen als Datenpunkte.
    const habits = [habit('a', { createdAt: '2026-06-22T00:00:00.000Z' })];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: 7/7
      log('a', '2026-06-29'), // Woche davor: 1/7
      log('a', '2026-06-22'), // noch eine Woche davor: 1/7
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'best-since', weeks: 2 });
  });

  it('Gleichstand mit der Vorwoche -> "so viel wie letzte Woche"', () => {
    const habits = [habit('a', { schedule: 'weekly' })];
    const logs = [
      log('a', '2026-07-08'), // Referenzwoche: 1/1
      log('a', '2026-07-01'), // Vorwoche: 1/1 (Gleichstand)
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'tied-with-last-week' });
  });

  it('weder besser noch gleich -> kein Superlativ', () => {
    const habits = [habit('a')];
    const logs = [
      ...LAST_WEEK_DAYS.slice(0, 3).map((d) => log('a', d)), // Referenzwoche: 0/1 (unvollständig)
      ...['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map(
        (d) => log('a', d),
      ), // Vorwoche: 1/1 (vollständig)
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 0, total: 1 });
    expect(recap?.superlative).toBeNull();
  });
});

describe('computeWeeklyRecap — AC5: zu wenig Historie', () => {
  it('erste erfasste Woche zeigt nur die Kennzahl, keinen Superlativ', () => {
    const habits = [habit('a', { createdAt: '2026-07-06T00:00:00.000Z' })];
    const logs = LAST_WEEK_DAYS.map((d) => log('a', d));
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 1, total: 1 });
    expect(recap?.superlative).toBeNull();
  });
});

describe('computeWeeklyRecap — AC6: keine aktiven Gewohnheiten', () => {
  it('keine Gewohnheiten überhaupt -> null', () => {
    expect(computeWeeklyRecap([], [], NOW)).toBeNull();
  });

  it('alle Gewohnheiten erst nach der Bezugswoche angelegt -> null', () => {
    const habits = [habit('a', { createdAt: '2026-07-14T00:00:00.000Z' })];
    expect(computeWeeklyRecap(habits, [], NOW)).toBeNull();
  });

  it('alle Gewohnheiten vor der Bezugswoche archiviert -> null', () => {
    const habits = [
      habit('a', { archivedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    expect(computeWeeklyRecap(habits, [], NOW)).toBeNull();
  });
});
