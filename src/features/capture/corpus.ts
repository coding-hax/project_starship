import type { CaptureConfidence, CaptureKind } from './types';

/**
 * Tabellengetriebenes Satz-Korpus (issue #621) — überlebt die Implementierung: läuft
 * später unveraendert gegen den Modell-Erkenner (#620), damit sich "besser" von
 * "nur anders" unterscheiden lässt. Jede Zeile der Signaltabelle hat einen Fall und
 * einen Gegenfall; dazu die Mindestbestand-Sätze aus #47.
 */

// Montag, 15.01.2024, 10:00 lokal — fester Bezugspunkt, unabhängig vom Testlauf-Tag.
export const NOW = new Date(2024, 0, 15, 10, 0, 0);

// Zweiter Bezugspunkt für AK6 (#688): derselbe Tag, aber nachmittags gesprochen —
// dieselbe Zeigerzeit liest sich dann als Nachmittags- statt Vormittagslesart.
export const NOW_AFTERNOON = new Date(2024, 0, 15, 15, 0, 0);

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
  /** Erwartete Fälligkeit/Startzeit (#688) — optional, die meisten Bestandsfälle prüfen
   * nur kind/habitId/confidence. */
  dueAt?: Date;
}

export interface CorpusCase {
  /** Fundort in der Signaltabelle bzw. Ticket-Herkunft, nur für lesbare Testnamen. */
  signal: string;
  text: string;
  habits?: { id: string; name: string }[];
  allowedKinds?: CaptureKind[];
  /** Bezugspunkt für diesen Fall — Default `NOW`. Für AK6 (#688) auf `NOW_AFTERNOON`. */
  now?: Date;
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

  // Verneinung kassiert den Habit-Treffer (AC6) — der teuerste Fehler im Korpus, weil er
  // sonst still eine Gewohnheit fälschlich abhakt.
  {
    signal: '#687 AC6: Verneinung kassiert den Habit-Treffer -> task, kein Abhaken',
    text: 'Sport heute nicht gemacht',
    expect: { kind: 'task' },
  },

  // #687 AC7: zusätzliche Fälle des Span+Ranking-Umbaus
  {
    signal: '#687 AC7: Aufgaben-Vokabular "nicht vergessen"',
    text: 'nicht vergessen: Pass verlängern',
    expect: { kind: 'task' },
  },
  {
    signal: '#687 AC7: Aufgaben-Vokabular "muss noch"',
    text: 'muss noch Reifen wechseln',
    expect: { kind: 'task' },
  },
  {
    signal: '#687 AC7: konkrete Uhrzeit, aber Kalender-Modul aus -> task, Zeit bleibt erhalten',
    text: 'Dienstag 12 Uhr Zahnarzt',
    allowedKinds: ['task', 'habit_check'],
    expect: { kind: 'task' },
  },

  // #688 AK1: Zeigerzeit, direkt angelegt — "halb zwölf" ist 11:30, nicht 12:30.
  {
    signal: '#688 AK1: "halb zwölf"',
    text: 'morgen halb zwölf Zahnarzt',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 11, 30) },
  },
  {
    signal: '#688 AK1: "um halb 12" (Ziffer statt Wort)',
    text: 'morgen um halb 12 Zahnarzt',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 11, 30) },
  },
  {
    signal: '#688 AK1: "viertel nach acht"',
    text: 'morgen viertel nach acht Frühstück',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 8, 15) },
  },
  {
    signal: '#688 AK1: "viertel vor neun"',
    text: 'morgen viertel vor neun Zahnarzt',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 8, 45) },
  },
  {
    signal: '#688 AK1: "Viertel vor 9" (Ziffer statt Wort)',
    text: 'morgen Viertel vor 9 Zahnarzt',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 8, 45) },
  },
  {
    signal: '#688 AK1: "halb acht"',
    text: 'morgen halb acht Frühstück',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 7, 30) },
  },

  // #688 AK2: zusammengesetzt mit Minutenangabe — fällt bei Vormittagslesart ins
  // Nachtfenster, senkt die Konfidenz (Grundlage für die erzwungene Bestätigung auf
  // dem Aufgaben-Pfad, route-capture.ts).
  {
    signal: '#688 AK2: "fünf vor halb drei" fällt ins Nachtfenster -> confidence low',
    text: 'morgen fünf vor halb drei Call',
    expect: { kind: 'event', confidence: 'low', dueAt: new Date(2024, 0, 16, 2, 25) },
  },
  {
    signal: '#688 AK2: "zehn nach halb drei" fällt ins Nachtfenster -> confidence low',
    text: 'morgen zehn nach halb drei Call',
    expect: { kind: 'event', confidence: 'low', dueAt: new Date(2024, 0, 16, 2, 40) },
  },

  // #688 AK3: Nachtfenster — geraten senkt die Konfidenz, ausgeschrieben (Doppelpunkt)
  // nie, außerhalb des Fensters bleibt es beim normalen Weg.
  {
    signal: '#688 AK3: "halb eins" fällt ins Nachtfenster -> confidence low',
    text: 'morgen halb eins Mittagessen',
    expect: { kind: 'event', confidence: 'low', dueAt: new Date(2024, 0, 16, 0, 30) },
  },
  {
    signal: '#688 AK3: "um 6" liegt außerhalb des Nachtfensters -> confidence high',
    text: 'morgen um 6 Sport',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 6, 0) },
  },
  {
    signal: '#688 AK3: "0:30" ist ausgeschrieben, nie geraten -> confidence high',
    text: 'morgen 0:30 Nachtschicht',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 0, 30) },
  },

  // #688 AK4: regionale Kurzformen ("viertel H"/"dreiviertel H" ohne vor/nach) senken
  // die Konfidenz unabhängig vom Nachtfenster — Verwechslungsgefahr mit "viertel nach H".
  {
    signal: '#688 AK4: "dreiviertel zwölf" (regional) -> confidence low',
    text: 'morgen dreiviertel zwölf Abgabe',
    expect: { kind: 'event', confidence: 'low', dueAt: new Date(2024, 0, 16, 11, 45) },
  },
  {
    signal: '#688 AK4: "viertel zwölf" (regional) -> confidence low',
    text: 'morgen viertel zwölf Abgabe',
    expect: { kind: 'event', confidence: 'low', dueAt: new Date(2024, 0, 16, 11, 15) },
  },

  // #688 AK5: ein Tageszeitwort schlägt die Tageshälften-Heuristik immer.
  {
    signal: '#688 AK5: "morgens" bestätigt die Heuristik, bleibt confidence high',
    text: 'morgen um 6 Uhr morgens Sport',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 6, 0) },
  },
  {
    signal: '#688 AK5: ohne Tageszeitwort entscheidet die Heuristik',
    text: 'morgen um 8 Standup',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 8, 0) },
  },
  {
    signal: '#688 AK5: "abends" schlägt die Heuristik (sonst vormittags gelesen)',
    text: 'morgen um 8 abends Kino',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 20, 0) },
  },
  {
    signal: '#688 AK5: "nachmittags" schlägt die Heuristik, Zahlwort statt Ziffer',
    text: 'morgen um drei nachmittags Kaffee',
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 15, 0) },
  },

  // #688 AK6: dieselbe Eingabe, zweiter Bezugspunkt (nachmittags gesprochen) -> andere
  // Tageshälfte. `now: NOW_AFTERNOON` statt einer zweiten Korpus-Datei.
  {
    signal: '#688 AK6: "halb acht", gesprochen um 15:00 -> Nachmittagslesart',
    text: 'morgen halb acht Frühstück',
    now: NOW_AFTERNOON,
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 19, 30) },
  },
  {
    signal: '#688 AK6: "um 8", gesprochen um 15:00 -> Nachmittagslesart',
    text: 'morgen um 8 Standup',
    now: NOW_AFTERNOON,
    expect: { kind: 'event', confidence: 'high', dueAt: new Date(2024, 0, 16, 20, 0) },
  },
];
