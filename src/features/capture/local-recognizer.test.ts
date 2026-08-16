import { describe, expect, it } from 'vitest';
import type { CaptureContext } from './types';
import { recognizeLocally } from './local-recognizer';
import { ALL_KINDS, CORPUS, NOW, STANDARD_HABITS } from './corpus';

function iso(year: number, month: number, day: number, hours = 9, minutes = 0): string {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    now: NOW,
    tz: 'Europe/Berlin',
    habits: STANDARD_HABITS,
    allowedKinds: ALL_KINDS,
    ...overrides,
  };
}

describe('recognizeLocally — Satz-Korpus (AC10, #47)', () => {
  for (const testCase of CORPUS) {
    it(`${testCase.signal}: "${testCase.text}" -> ${testCase.expect.kind}`, () => {
      const result = recognizeLocally(
        testCase.text,
        ctx({
          habits: testCase.habits ?? STANDARD_HABITS,
          allowedKinds: testCase.allowedKinds ?? ALL_KINDS,
          now: testCase.now ?? NOW,
        }),
      );
      const [draft] = result.items;

      expect(draft.kind).toBe(testCase.expect.kind);
      if ('habitId' in testCase.expect) {
        expect(draft.habitId).toBe(testCase.expect.habitId);
      }
      if (testCase.expect.confidence) {
        for (const [field, expected] of Object.entries(testCase.expect.confidence)) {
          expect(draft.confidence[field as keyof typeof draft.confidence]).toEqual(expected);
        }
      }
      if (testCase.expect.dueAt) {
        expect(draft.dueAt).toBe(testCase.expect.dueAt.toISOString());
      }
      if (testCase.expect.logDate) {
        expect(draft.logDate).toBe(testCase.expect.logDate);
      }
      if ('newHabit' in testCase.expect) {
        expect(draft.newHabit).toBe(testCase.expect.newHabit);
      }
      if (testCase.expect.title !== undefined) {
        expect(draft.title).toBe(testCase.expect.title);
      }
    });
  }
});

describe('recognizeLocally — einzelne Akzeptanzkriterien', () => {
  it('AC4: konkrete Uhrzeit -> event mit absoluter Startzeit gegen now/tz', () => {
    const result = recognizeLocally('Dienstag 12 Uhr Zahnarzt', ctx());
    expect(result.items[0].kind).toBe('event');
    expect(result.items[0].dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC5: Datum ohne Uhrzeit -> task mit Fälligkeit (Default 09:00)', () => {
    const result = recognizeLocally('Dienstag Steuer machen', ctx());
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].dueAt).toBe(iso(2024, 1, 16, 9, 0));
  });

  it('AC7: allowedKinds ohne "event" degradiert einen als Termin gepunkteten Satz zu task, die Zeit geht nicht verloren', () => {
    const result = recognizeLocally('Dienstag 12 Uhr Zahnarzt', ctx({ allowedKinds: ['task', 'habit_check'] }));
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].dueAt).toBe(iso(2024, 1, 16, 12, 0));
  });

  it('AC8: mehrere gleich starke Habit-Treffer -> Feld-Konfidenz "Gewohnheit" guessed, keine habitId', () => {
    const result = recognizeLocally(
      'hake Yoga Lauf ab',
      ctx({ habits: STANDARD_HABITS }),
    );
    expect(result.items[0].kind).toBe('habit_check');
    expect(result.items[0].habitId).toBeNull();
    expect(result.items[0].confidence.habit.level).toBe('guessed');
  });

  it('AC9: Rückgabe ist immer { items: [...] }, auch bei genau einem Ergebnis', () => {
    const result = recognizeLocally('Milch kaufen', ctx());
    expect(result).toEqual({ items: expect.any(Array) });
    expect(result.items).toHaveLength(1);
  });

  it('reine Funktion: gleicher Text + gleicher Kontext -> gleiches Ergebnis (keine versteckten Seiteneffekte)', () => {
    const first = recognizeLocally('hake Sport ab', ctx());
    const second = recognizeLocally('hake Sport ab', ctx());
    expect(second).toEqual(first);
  });
});

describe('recognizeLocally — #780 provisional (AK1/AK2)', () => {
  it('AK1: leerer Text -> provisional, der sichere Rückfall ist task ohne Signal', () => {
    const result = recognizeLocally('', ctx());
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].provisional).toBe(true);
  });

  it('AK1: ein Satz ohne jedes Art-Signal -> weiterhin provisional', () => {
    const result = recognizeLocally('Wäsche waschen', ctx());
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].provisional).toBe(true);
  });

  it('AK1: sobald das erste Signal da ist (Uhrzeit) -> nicht mehr provisional', () => {
    const result = recognizeLocally('morgen 12 Uhr Zahnarzt', ctx());
    expect(result.items[0].kind).toBe('event');
    expect(result.items[0].provisional).toBe(false);
  });

  it('ein Task-Vokabular-Signal ohne Datum/Zeit ist ebenfalls kein Rückfall mehr -> nicht provisional', () => {
    const result = recognizeLocally('erinnere mich an Müll rausbringen', ctx());
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].provisional).toBe(false);
  });

  it('eine Degradierung (Modul aus) ist eine bewusste Entscheidung, keine provisorische', () => {
    const result = recognizeLocally('Dienstag 12 Uhr Zahnarzt', ctx({ allowedKinds: ['task', 'habit_check'] }));
    expect(result.items[0].kind).toBe('task');
    expect(result.items[0].provisional).toBe(false);
  });
});
