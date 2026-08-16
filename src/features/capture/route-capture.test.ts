import { describe, expect, it } from 'vitest';
import { berlinNow } from '@/push/schedule';
import { utteranceMentions } from './local-recognizer';
import type { CaptureContext } from './types';
import {
  allowedCaptureKinds,
  describeDroppedFields,
  eventFieldsFromDraft,
  habitFieldsFromDraft,
  mergeDraft,
  previewDraft,
  summarizeChanges,
  taskFieldsFromDraft,
} from './route-capture';
import { ALL_KINDS, NOW, NOW_NIGHT, STANDARD_HABITS } from './corpus';

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    now: NOW,
    tz: 'Europe/Berlin',
    habits: STANDARD_HABITS,
    allowedKinds: ALL_KINDS,
    ...overrides,
  };
}

describe('previewDraft — task', () => {
  it('reicht einen erkannten Task unverändert als Kernfelder durch', () => {
    const draft = previewDraft('Wäsche waschen', ctx());
    expect(draft.kind).toBe('task');
    expect(taskFieldsFromDraft(draft)).toEqual({
      kind: 'task',
      title: 'Wäsche waschen',
      dueAt: null,
      needsConfirmation: false,
      titleConfidence: { level: 'high' },
      dateConfidence: { level: 'high' },
      timeConfidence: { level: 'high' },
    });
  });
});

describe('previewDraft — event', () => {
  it('AC1: explizite Uhrzeit -> Zeit-Termin, Ende eine Stunde nach dem Start', () => {
    const draft = previewDraft('Dienstag 12 Uhr Zahnarzt', ctx());
    expect(draft.kind).toBe('event');
    const fields = eventFieldsFromDraft(draft, NOW);
    expect(fields.allDay).toBe(false);
    expect(fields.startDate).toBeNull();
    expect(fields.endDate).toBeNull();
    expect(fields.startsAt).not.toBeNull();
    expect(fields.endsAt).not.toBeNull();
    const start = new Date(fields.startsAt as string);
    const end = new Date(fields.endsAt as string);
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it('AC2: kein Datum erkannt (reines Vokabular) -> ganztägig auf den heutigen Tag', () => {
    const draft = previewDraft('Meeting mit Chef', ctx());
    expect(draft.kind).toBe('event');
    const fields = eventFieldsFromDraft(draft, NOW);
    expect(fields.allDay).toBe(true);
    expect(fields.startsAt).toBeNull();
    expect(fields.endsAt).toBeNull();
    const today = berlinNow(NOW).dateKey;
    expect(fields.startDate).toBe(today);
    expect(fields.endDate).toBe(today);
  });

  it('#689 R6: ganztägig zwischen 00:00 und 03:59 landet auf dem logischen, nicht dem realen Kalendertag', () => {
    const draft = previewDraft('Meeting mit Chef', ctx({ now: NOW_NIGHT }));
    const fields = eventFieldsFromDraft(draft, NOW_NIGHT);
    expect(fields.startDate).toBe('2024-01-15');
    expect(fields.endDate).toBe('2024-01-15');
  });

  it('issue #715: eine von Hand auf "Termin" überschriebene Art übernimmt trotzdem die erkannte Uhrzeit eines als task klassifizierten Satzes', () => {
    // "Dienstag 12 Uhr" triggert zwar event, aber ein Titel ohne Zeitsignal
    // (task-Klassifikation) muss beim Kernfeld-Mapping trotzdem funktionieren.
    const draft = previewDraft('Wäsche waschen', ctx());
    expect(draft.kind).toBe('task');
    const fields = eventFieldsFromDraft(draft, NOW);
    // Kein Datum erkannt -> derselbe ganztägig-Rückfall wie oben, unabhängig
    // davon, dass der Recognizer selbst `task` klassifiziert hat.
    expect(fields.allDay).toBe(true);
    expect(fields.title).toBe('Wäsche waschen');
  });
});

describe('habitFieldsFromDraft', () => {
  it('AC3: hohe Konfidenz -> aufgelöst, mit Habit-Id und Log-Tag', () => {
    const draft = previewDraft('hake Sport ab', ctx());
    const fields = habitFieldsFromDraft(draft, NOW);
    expect(fields).toEqual({ resolved: true, habitId: 'h-sport', logDate: '2024-01-15' });
  });

  it('#689 R7: ein genanntes Datum im Abhaken-Satz steuert den Log-Tag, nicht heute', () => {
    const draft = previewDraft('Sport für gestern abhaken', ctx());
    const fields = habitFieldsFromDraft(draft, NOW);
    expect(fields).toEqual({ resolved: true, habitId: 'h-sport', logDate: '2024-01-14' });
  });

  it('AC4/AK5: mehrdeutiger Habit-Treffer -> nicht aufgelöst, „Keiner Gewohnheit zugeordnet"', () => {
    const draft = previewDraft('hake Yoga Lauf ab', ctx());
    const fields = habitFieldsFromDraft(draft, NOW);
    expect(fields.resolved).toBe(false);
    expect(fields.habitId).toBeNull();
  });

  it('AK5: kein Habit-Treffer überhaupt -> nicht aufgelöst', () => {
    // "Wäsche erledigt" hat keinen Habit-Treffer -> local-recognizer klassifiziert
    // das schon als task (#621 Korpus), landet also gar nicht im habit_check-Zweig.
    const draft = previewDraft('Wäsche erledigt', ctx());
    expect(draft.kind).toBe('task');
    const fields = habitFieldsFromDraft(draft, NOW);
    expect(fields.resolved).toBe(false);
  });

  it('issue #715 AK5: eine von Hand auf „Routine" überschriebene Art ohne erkanntes Datum fällt auf den logischen Heute-Tag zurück', () => {
    const draft = previewDraft('Wäsche waschen', ctx());
    expect(draft.kind).toBe('task');
    const fields = habitFieldsFromDraft(draft, NOW);
    expect(fields.logDate).toBe(berlinNow(NOW).dateKey);
  });
});

describe('mergeDraft (issue #716, „Vorschau-Merge")', () => {
  it('AK1: Erstbelegung übernimmt die Äußerung unverändert (Passthrough, inkl. Konfidenzen und Art)', () => {
    const utterance = previewDraft('Zahnarzt', ctx());
    const mentions = utteranceMentions('Zahnarzt', ctx());
    expect(mergeDraft(null, utterance, mentions)).toEqual(utterance);
  });

  it('AK3/AK4: ein nicht genanntes Feld behält Wert UND Konfidenz aus dem bisherigen Stand', () => {
    const prev = previewDraft('Zahnarzt morgen', ctx());
    const utterance = previewDraft('eher', ctx());
    const mentions = utteranceMentions('eher', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.title).toBe(prev.title);
    expect(next.confidence.title).toEqual(prev.confidence.title);
    expect(next.dueAt).toBe(prev.dueAt);
    expect(next.confidence.date).toEqual(prev.confidence.date);
    expect(next.confidence.time).toEqual(prev.confidence.time);
  });

  it('AK2: ein genanntes Feld überschreibt Wert UND übernimmt die Konfidenz der neuen Äußerung', () => {
    const prev = previewDraft('Einkaufen', ctx());
    const utterance = previewDraft('morgen', ctx());
    const mentions = utteranceMentions('morgen', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.dueAt).toBe(utterance.dueAt);
    expect(next.confidence.date).toEqual(utterance.confidence.date);
  });

  it('AK2: ein erneut genannter Habit-Treffer überschreibt habitId', () => {
    const prev = previewDraft('hake Sport ab', ctx());
    const utterance = previewDraft('hake Yoga ab', ctx());
    const mentions = utteranceMentions('hake Yoga ab', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.habitId).toBe('h-yoga');
  });

  it('AK4: erneutes explizites Nennen hebt eine geratene Konfidenz auf sicher', () => {
    const prev = previewDraft('Zahnarzt morgen', ctx());
    expect(prev.confidence.time.level).toBe('guessed');
    const utterance = previewDraft('um 15 Uhr', ctx());
    const mentions = utteranceMentions('um 15 Uhr', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.confidence.date.level).toBe('high');
    expect(next.confidence.time.level).toBe('high');
  });

  it('Entscheidung C: die Art bleibt nach der ersten Übernahme fix, auch wenn die neue Äußerung für sich allein anders klassifizieren würde', () => {
    const prev = previewDraft('Einkaufen', ctx());
    expect(prev.kind).toBe('task');
    const utterance = previewDraft('morgen um 15 Uhr', ctx());
    expect(utterance.kind).toBe('event');
    const mentions = utteranceMentions('morgen um 15 Uhr', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.kind).toBe('task');
  });

  it('Entscheidung B: ein reines Füllwort überschreibt einen gesetzten Titel nicht', () => {
    const prev = previewDraft('Einkaufen', ctx());
    const utterance = previewDraft('eher um 15 Uhr', ctx());
    const mentions = utteranceMentions('eher um 15 Uhr', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.title).toBe('Einkaufen');
  });

  it('#780: provisional bleibt nach der ersten Übernahme fix, auch ohne Signal in der Folge-Äußerung', () => {
    const prev = previewDraft('Einkaufen', ctx());
    expect(prev.provisional).toBe(true);
    const utterance = previewDraft('gehen', ctx());
    const mentions = utteranceMentions('gehen', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.provisional).toBe(true);
  });

  it('#780: provisional bleibt auch dann fix, wenn eine Folge-Äußerung für sich allein ein Signal trüge', () => {
    const prev = previewDraft('Einkaufen', ctx());
    expect(prev.provisional).toBe(true);
    const utterance = previewDraft('morgen um 15 Uhr', ctx());
    expect(utterance.provisional).toBe(false);
    const mentions = utteranceMentions('morgen um 15 Uhr', ctx());
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.provisional).toBe(true);
  });

  it('#780: newHabit überschreibt nur, wenn die Folge-Äußerung selbst einen Habit-Treffer nennt', () => {
    const prev = previewDraft('Routine Wasser trinken', ctx());
    expect(prev.newHabit).toBe(true);
    const utterance = previewDraft('trinken', ctx());
    const mentions = utteranceMentions('trinken', ctx());
    expect(mentions.habit).toBe(false);
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.newHabit).toBe(true);
  });

  it('#780: ein erneut genannter Habit-Treffer überschreibt newHabit auf false', () => {
    const prev = previewDraft('Routine Sport', ctx({ habits: [] }));
    expect(prev.newHabit).toBe(true);
    const utterance = previewDraft('hake Sport ab', ctx());
    const mentions = utteranceMentions('hake Sport ab', ctx());
    expect(mentions.habit).toBe(true);
    const next = mergeDraft(prev, utterance, mentions);
    expect(next.newHabit).toBe(false);
  });
});

describe('summarizeChanges (AK5)', () => {
  it('keine Änderung -> kein Text', () => {
    expect(summarizeChanges([])).toBeNull();
  });

  it('ein geändertes Feld', () => {
    expect(summarizeChanges(['Fälligkeit'])).toBe('Fälligkeit aktualisiert.');
  });

  it('mehrere geänderte Felder', () => {
    expect(summarizeChanges(['Titel', 'Fälligkeit'])).toBe('Titel und Fälligkeit aktualisiert.');
  });
});

describe('describeDroppedFields (AK6)', () => {
  it('keine entfallenen Felder -> kein Text', () => {
    expect(describeDroppedFields([])).toBeNull();
  });

  it('ein entfallenes Feld, Singular', () => {
    expect(describeDroppedFields(['Priorität'])).toBe('Priorität entfällt.');
  });

  it('mehrere entfallene Felder, Plural', () => {
    expect(describeDroppedFields(['Kategorie', 'Wiederholung'])).toBe(
      'Kategorie und Wiederholung entfallen.',
    );
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
