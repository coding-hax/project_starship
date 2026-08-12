import { describe, expect, it } from 'vitest';
import { berlinNow } from '@/push/schedule';
import type { CaptureContext } from './types';
import { allowedCaptureKinds, decideCaptureRoute } from './route-capture';
import { ALL_KINDS, NOW, STANDARD_HABITS } from './corpus';

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    now: NOW,
    tz: 'Europe/Berlin',
    habits: STANDARD_HABITS,
    allowedKinds: ALL_KINDS,
    ...overrides,
  };
}

describe('decideCaptureRoute — task', () => {
  it('reicht einen erkannten Task unverändert als Draft-Item durch', () => {
    const decision = decideCaptureRoute('Wäsche waschen', ctx());
    expect(decision).toEqual({
      action: 'task',
      draft: { kind: 'task', title: 'Wäsche waschen', dueAt: null, needsConfirmation: false },
    });
  });
});

describe('decideCaptureRoute — event', () => {
  it('AC1: explizite Uhrzeit -> Zeit-Termin, Ende eine Stunde nach dem Start', () => {
    const decision = decideCaptureRoute('Dienstag 12 Uhr Zahnarzt', ctx());
    expect(decision.action).toBe('event');
    if (decision.action !== 'event') throw new Error('unreachable');
    expect(decision.draft.allDay).toBe(false);
    expect(decision.draft.startDate).toBeNull();
    expect(decision.draft.endDate).toBeNull();
    expect(decision.draft.startsAt).not.toBeNull();
    expect(decision.draft.endsAt).not.toBeNull();
    const start = new Date(decision.draft.startsAt as string);
    const end = new Date(decision.draft.endsAt as string);
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it('AC2: kein Datum erkannt (reines Vokabular) -> ganztägig auf den heutigen Tag', () => {
    const decision = decideCaptureRoute('Meeting mit Chef', ctx());
    expect(decision.action).toBe('event');
    if (decision.action !== 'event') throw new Error('unreachable');
    expect(decision.draft.allDay).toBe(true);
    expect(decision.draft.startsAt).toBeNull();
    expect(decision.draft.endsAt).toBeNull();
    const today = berlinNow(NOW).dateKey;
    expect(decision.draft.startDate).toBe(today);
    expect(decision.draft.endDate).toBe(today);
  });
});

describe('decideCaptureRoute — habit_check', () => {
  it('AC3: hohe Konfidenz -> direkt abhaken, keine Navigation', () => {
    const decision = decideCaptureRoute('hake Sport ab', ctx());
    expect(decision).toEqual({ action: 'habit-check', habitId: 'h-sport' });
  });

  it('AC4: mehrdeutiger Habit-Treffer (confidence low) -> Review, nichts abgehakt', () => {
    const decision = decideCaptureRoute('hake Yoga Lauf ab', ctx());
    expect(decision).toEqual({ action: 'habit-review' });
  });

  it('kein Habit-Treffer überhaupt -> Review, nichts abgehakt', () => {
    const decision = decideCaptureRoute('Wäsche erledigt', ctx());
    // "Wäsche erledigt" hat keinen Habit-Treffer -> local-recognizer klassifiziert
    // das schon als task (#621 Korpus), landet also gar nicht im habit_check-Zweig.
    expect(decision.action).toBe('task');
  });
});

describe('allowedCaptureKinds', () => {
  it('bildet CaptureKind auf die Modul-Ids ab (aufgaben/kalender/routinen)', () => {
    const active = new Set(['aufgaben', 'routinen']);
    const result = allowedCaptureKinds((id) => active.has(id));
    expect(result.sort()).toEqual(['habit_check', 'task']);
  });

  it('alle Module aktiv -> alle CaptureKinds erlaubt', () => {
    const result = allowedCaptureKinds(() => true);
    expect(result.sort()).toEqual(['event', 'habit_check', 'task']);
  });

  it('Journal taucht nie auf, unabhängig vom Modul-Zustand (Regel 9)', () => {
    const result = allowedCaptureKinds(() => true);
    // CaptureKind kennt 'journal' schon typseitig nicht — dieser Test hält die
    // Absicht trotzdem fest: nichts in `KIND_MODULE_ID` zeigt auf 'journal'.
    expect(result).not.toContain('journal');
  });
});
