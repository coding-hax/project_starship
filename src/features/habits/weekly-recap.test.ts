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
// Eine Kalenderwoche bzw. zwei Kalenderwochen vor LAST_WEEK_DAYS (#504).
const WEEK_MINUS_1_DAYS = [
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-07-03',
  '2026-07-04',
  '2026-07-05',
];
const WEEK_MINUS_2_DAYS = [
  '2026-06-22',
  '2026-06-23',
  '2026-06-24',
  '2026-06-25',
  '2026-06-26',
  '2026-06-27',
  '2026-06-28',
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

describe('computeWeeklyRecap — Superlativ: best-ever braucht Mindesthistorie (#504 AC1)', () => {
  it('schlägt >= 3 frühere Datenwochen -> "Deine beste Woche"', () => {
    const habits = [habit('a', { createdAt: '2026-06-01T00:00:00.000Z' })];
    const logs = LAST_WEEK_DAYS.map((d) => log('a', d)); // Referenzwoche: 7/7, sonst keine Logs -> alle Vorwochen 0/7
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'best-ever' });
  });
});

describe('computeWeeklyRecap — Superlativ: zu wenig Historie für best-ever (#504 AC2)', () => {
  it('genau 1 Vorwoche mit Daten geschlagen -> kein Superlativ', () => {
    // createdAt so gesetzt, dass genau eine Vorwoche als Datenpunkt existiert
    // (die Woche davor liegt vor der Gründung der Gewohnheit).
    const habits = [habit('a', { createdAt: '2026-06-29T00:00:00.000Z' })];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: 7/7
      log('a', '2026-06-29'), // Vorwoche: 1/7 -> unvollständig, aber die einzige Datenwoche
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toBeNull();
  });

  it('genau 2 Vorwochen mit Daten geschlagen -> kein Superlativ', () => {
    // createdAt begrenzt die Historie auf genau zwei Vorwochen als Datenpunkte.
    const habits = [habit('a', { createdAt: '2026-06-22T00:00:00.000Z' })];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: 7/7
      log('a', '2026-06-29'), // Woche davor: 1/7
      log('a', '2026-06-22'), // noch eine Woche davor: 1/7
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toBeNull();
  });
});

describe('computeWeeklyRecap — Superlativ: best-since mit Kalenderabstand (#504 AC3)', () => {
  it('bessere Woche 2 Kalenderwochen zurück -> "Beste Woche seit 2 Wochen"', () => {
    const habits = [
      habit('a', { createdAt: '2026-05-01T00:00:00.000Z' }),
      habit('b', { createdAt: '2026-05-01T00:00:00.000Z' }),
      habit('c', { createdAt: '2026-05-01T00:00:00.000Z' }),
    ];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: a,b voll -> 2/3
      ...LAST_WEEK_DAYS.map((d) => log('b', d)),
      ...WEEK_MINUS_1_DAYS.map((d) => log('a', d)), // Vorwoche (distance 1): nur a voll -> 1/3, schlechter
      ...WEEK_MINUS_2_DAYS.map((d) => log('a', d)), // 2 Kalenderwochen zurück (distance 2): alle voll -> 3/3, besser
      ...WEEK_MINUS_2_DAYS.map((d) => log('b', d)),
      ...WEEK_MINUS_2_DAYS.map((d) => log('c', d)),
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'best-since', weeks: 2 });
  });

  it('Kalenderwoche ohne aktive Gewohnheit zählt beim Abstand mit', () => {
    // "p" ist während der Vorwoche (distance 1) bereits archiviert, "q"
    // existiert erst ab der Referenzwoche -- die Vorwoche hat deshalb gar
    // keine aktive Gewohnheit (total 0, kein Datenpunkt), zählt aber
    // trotzdem als Kalenderwoche für den Abstand zur besseren Woche davor.
    const habits = [
      habit('p', { createdAt: '2026-06-22T00:00:00.000Z', archivedAt: '2026-06-29T00:00:00.000Z' }),
      habit('q', { createdAt: '2026-07-06T00:00:00.000Z' }),
    ];
    const logs = WEEK_MINUS_2_DAYS.map((d) => log('p', d)); // distance 2: p voll -> 1/1; Referenzwoche: q ohne Logs -> 0/1
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'best-since', weeks: 2 });
  });
});

describe('computeWeeklyRecap — Superlativ: direkte Vorwoche war besser (#504 AC4)', () => {
  it('bessere Woche genau 1 Kalenderwoche zurück -> kein Superlativ (kein "seit 1 Wochen")', () => {
    const habits = [
      habit('a', { createdAt: '2026-06-01T00:00:00.000Z' }),
      habit('b', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const logs = [
      ...WEEK_MINUS_1_DAYS.map((d) => log('a', d)), // Vorwoche: a voll, b nicht -> 1/2 (besser als Referenz)
    ]; // Referenzwoche: keine Logs -> 0/2
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toBeNull();
  });
});

describe('computeWeeklyRecap — Superlativ: Gleichstand mit der Vorwoche (AC5 aus #431)', () => {
  it('Gleichstand mit der Vorwoche -> "so viel wie letzte Woche"', () => {
    const habits = [habit('a', { schedule: 'weekly' })];
    const logs = [
      log('a', '2026-07-08'), // Referenzwoche: 1/1
      log('a', '2026-07-01'), // Vorwoche: 1/1 (Gleichstand)
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'tied-with-last-week' });
  });

  it('Gleichstand mit der Vorwoche gewinnt gegen eine bessere Woche weiter zurück (#504 Präzedenz)', () => {
    const habits = [
      habit('a', { createdAt: '2026-05-01T00:00:00.000Z' }),
      habit('b', { createdAt: '2026-05-01T00:00:00.000Z' }),
      habit('c', { createdAt: '2026-05-01T00:00:00.000Z' }),
    ];
    const logs = [
      ...LAST_WEEK_DAYS.map((d) => log('a', d)), // Referenzwoche: a,b voll -> 2/3
      ...LAST_WEEK_DAYS.map((d) => log('b', d)),
      ...WEEK_MINUS_1_DAYS.map((d) => log('a', d)), // Vorwoche: a,b voll -> 2/3 (Gleichstand)
      ...WEEK_MINUS_1_DAYS.map((d) => log('b', d)),
      ...WEEK_MINUS_2_DAYS.map((d) => log('a', d)), // 2 Wochen zurück: alle voll -> 3/3 (besser, aber nachrangig)
      ...WEEK_MINUS_2_DAYS.map((d) => log('b', d)),
      ...WEEK_MINUS_2_DAYS.map((d) => log('c', d)),
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.superlative).toEqual({ kind: 'tied-with-last-week' });
  });

  it('weder besser noch gleich -> kein Superlativ', () => {
    const habits = [habit('a')];
    const logs = [
      ...LAST_WEEK_DAYS.slice(0, 3).map((d) => log('a', d)), // Referenzwoche: 0/1 (unvollständig)
      ...WEEK_MINUS_1_DAYS.map((d) => log('a', d)), // Vorwoche: 1/1 (vollständig)
    ];
    const recap = computeWeeklyRecap(habits, logs, NOW);
    expect(recap?.metric).toEqual({ met: 0, total: 1 });
    expect(recap?.superlative).toBeNull();
  });
});

describe('computeWeeklyRecap — AC5 aus #431: zu wenig Historie', () => {
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
