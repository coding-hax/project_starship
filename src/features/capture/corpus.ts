import type { CaptureConfidence, CaptureKind } from './types';

/**
 * Tabellengetriebenes Satz-Korpus (issue #621) — überlebt die Implementierung: läuft
 * später unveraendert gegen den Modell-Erkenner (#620), damit sich "besser" von
 * "nur anders" unterscheiden lässt. Jede Zeile der Signaltabelle hat einen Fall und
 * einen Gegenfall; dazu die Mindestbestand-Sätze aus #47.
 */

// Montag, 15.01.2024, 10:00 lokal — fester Bezugspunkt, unabhängig vom Testlauf-Tag.
export const NOW = new Date(2024, 0, 15, 10, 0, 0);

export const STANDARD_HABITS = [
  { id: 'h-sport', name: 'Sport' },
  { id: 'h-yoga', name: 'Yoga' },
  { id: 'h-lauf', name: 'Lauf' },
];

export const ALL_KINDS: CaptureKind[] = ['task', 'event', 'habit_check'];

export interface CorpusExpectation {
  kind: CaptureKind;
  habitId?: string | null;
  confidence?: CaptureConfidence;
}

export interface CorpusCase {
  /** Fundort in der Signaltabelle bzw. Ticket-Herkunft, nur für lesbare Testnamen. */
  signal: string;
  text: string;
  habits?: { id: string; name: string }[];
  allowedKinds?: CaptureKind[];
  expect: CorpusExpectation;
}

export const CORPUS: CorpusCase[] = [
  // Erledigungsverb + Habit-Treffer -> habit_check (AC1)
  {
    signal: 'Erledigungsverb + Habit-Treffer (Fall)',
    text: 'hake Sport ab',
    expect: { kind: 'habit_check', habitId: 'h-sport', confidence: 'high' },
  },
  // Gegenfall: Erledigungsverb ohne Habit-Treffer -> nicht habit_check (AC2)
  {
    signal: 'Erledigungsverb + Habit-Treffer (Gegenfall: kein Habit-Treffer)',
    text: 'Wäsche erledigt',
    expect: { kind: 'task' },
  },
  // Gegenfall: Habit-Name ohne Erledigungsverb -> task, kein Abhaken (AC3)
  {
    signal: 'Erledigungsverb + Habit-Treffer (Gegenfall: kein Verb)',
    text: 'Sport',
    expect: { kind: 'task', habitId: null },
  },

  // konkrete Uhrzeit -> event (AC4)
  {
    signal: 'konkrete Uhrzeit (Fall)',
    text: 'Dienstag 12 Uhr Zahnarzt',
    expect: { kind: 'event' },
  },
  // Gegenfall: nur Datum, keine Uhrzeit -> task mit Fälligkeit (AC5)
  {
    signal: 'konkrete Uhrzeit (Gegenfall: nur Datum)',
    text: 'Dienstag Steuer machen',
    expect: { kind: 'task' },
  },

  // Termin-Vokabular -> event
  {
    signal: 'Termin-Vokabular (Fall)',
    text: 'Meeting mit Chef',
    expect: { kind: 'event' },
  },
  // Gegenfall: nichts davon -> task, der sichere Rückfall
  {
    signal: 'Termin-Vokabular (Gegenfall: nichts davon)',
    text: 'Wohnung aufräumen',
    expect: { kind: 'task' },
  },

  // Aufgaben-Vokabular -> task
  {
    signal: 'Aufgaben-Vokabular (Fall)',
    text: 'erinnere mich an Müll rausbringen',
    expect: { kind: 'task' },
  },
  // Gegenfall: nichts davon -> task, der sichere Rückfall
  {
    signal: 'Aufgaben-Vokabular (Gegenfall: nichts davon)',
    text: 'Paket abholen',
    expect: { kind: 'task' },
  },

  // Erledigen schlägt Anlegen (AC6)
  {
    signal: 'Erledigen schlägt Anlegen',
    text: 'Termin morgen Sport abhaken',
    expect: { kind: 'habit_check', habitId: 'h-sport' },
  },

  // Mehrere gleich starke Habit-Treffer -> confidence: 'low', keine habitId (AC8)
  {
    signal: 'mehrdeutiger Habit-Treffer',
    text: 'hake Yoga Lauf ab',
    expect: { kind: 'habit_check', habitId: null, confidence: 'low' },
  },

  // Mindestbestand aus #47
  {
    signal: '#47: "erstelle einen Termin..."',
    text: 'erstelle einen Termin für morgen um 12, Titel Doktor',
    expect: { kind: 'event' },
  },
  {
    signal: '#47: "hake meine Routine Sport..."',
    text: 'hake meine Routine Sport für heute ab',
    expect: { kind: 'habit_check', habitId: 'h-sport', confidence: 'high' },
  },
];
