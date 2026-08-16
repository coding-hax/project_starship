import type { CaptureConfidenceField, CaptureKind, FieldConfidence } from './types';

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

// Nacht-Bezugspunkt für AK5/AK6 (#689, R6/R7): Dienstag 01:30 — logischer Tag ist noch
// Montag 15.01. (die Tagesgrenze 04:00).
export const NOW_NIGHT = new Date(2024, 0, 16, 1, 30, 0);

export const STANDARD_HABITS = [
  { id: 'h-sport', name: 'Sport' },
  { id: 'h-yoga', name: 'Yoga' },
  { id: 'h-lauf', name: 'Lauf' },
];

export const ALL_KINDS: CaptureKind[] = ['task', 'event', 'habit_check'];

export interface CorpusExpectation {
  kind: CaptureKind;
  habitId?: string | null;
  /** Erwartete Fälligkeit/Startzeit (#688) — optional, die meisten Bestandsfälle prüfen
   * nur kind/habitId/confidence. */
  dueAt?: Date;
  /** Erwarteter Log-Tag `YYYY-MM-DD` bei `kind: 'habit_check'` (R6/R7, #689). */
  logDate?: string;
  /** #691: erwartete Feld-Konfidenz — nur die Felder, die dieser Fall wirklich prüft. */
  confidence?: Partial<Record<CaptureConfidenceField, FieldConfidence>>;
  /** #780: erwarteter `newHabit`-Wert — nur die Fälle, die den Routine-Intent prüfen. */
  newHabit?: boolean;
  /** #780: erwarteter Titel — bislang nur für den `newHabit`-Zweig relevant (E1: das
   * führende Intent-Wort verschwindet aus dem Namen). */
  title?: string;
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
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
    },
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
    expect: {
      kind: 'event',
      // #691: der Wochentag ist geraten, "12 Uhr" ist der Fixpunkt Mittag — kein
      // Tageshälften-Rätsel, also nicht geraten (Zwölf-Sonderfall in resolveHourMatch).
      confidence: {
        date: { level: 'guessed', reason: 'Wochentag ohne Datum' },
        time: { level: 'high' },
      },
    },
  },
  // Gegenfall: nur Datum, keine Uhrzeit -> task mit Fälligkeit (AC5)
  {
    signal: 'konkrete Uhrzeit (Gegenfall: nur Datum)',
    text: 'Dienstag Steuer machen',
    expect: {
      kind: 'task',
      // #691: Row „Datum ohne Wochentag" + Row „keine Uhrzeit gesagt" in einem Fall.
      confidence: {
        date: { level: 'guessed', reason: 'Wochentag ohne Datum' },
        time: { level: 'guessed', reason: 'keine Uhrzeit gesagt' },
      },
    },
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

  // Mehrere gleich starke Habit-Treffer -> Feld-Konfidenz "Gewohnheit" geraten, keine habitId (AC8)
  {
    signal: 'mehrdeutiger Habit-Treffer',
    text: 'hake Yoga Lauf ab',
    expect: {
      kind: 'habit_check',
      habitId: null,
      confidence: { habit: { level: 'guessed', reason: 'unsicherer Gewohnheitstreffer' } },
    },
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
    expect: { kind: 'habit_check', habitId: 'h-sport', confidence: { habit: { level: 'high' } } },
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
    expect: {
      kind: 'task',
      // #691: die Degradierung ist eine bewusste Regel, keine unklare Rangfolge —
      // Feld-Konfidenz "Art" bleibt `high`, obwohl "event" eigentlich gewonnen hätte.
      confidence: { kind: { level: 'high' } },
    },
  },

  // #688 AK1: Zeigerzeit, direkt angelegt — "halb zwölf" ist 11:30, nicht 12:30.
  // #691: keines dieser Beispiele nennt ein Tageszeitwort — die Tageshälfte kommt aus
  // dem Sprechzeitpunkt (R2), die Feld-Konfidenz "Uhrzeit" ist deshalb überall `guessed`,
  // unabhängig davon, dass `needsConfirmation` (unverändert, Nachtfenster-Regel) hier
  // überall `false` bleibt — zwei unabhängige Signale seit #691.
  {
    signal: '#688 AK1: "halb zwölf"',
    text: 'morgen halb zwölf Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 11, 30),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK1: "um halb 12" (Ziffer statt Wort)',
    text: 'morgen um halb 12 Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 11, 30),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK1: "viertel nach acht"',
    text: 'morgen viertel nach acht Frühstück',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 8, 15),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK1: "viertel vor neun"',
    text: 'morgen viertel vor neun Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 8, 45),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK1: "Viertel vor 9" (Ziffer statt Wort)',
    text: 'morgen Viertel vor 9 Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 8, 45),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK1: "halb acht"',
    text: 'morgen halb acht Frühstück',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 7, 30),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },

  // #688 AK2: zusammengesetzt mit Minutenangabe — fällt bei Vormittagslesart ins
  // Nachtfenster, was seit vor #691 `needsConfirmation` erzwingt (unverändert). Die
  // Feld-Konfidenz "Uhrzeit" ist unabhängig davon `guessed` (kein Tageszeitwort).
  {
    signal: '#688 AK2: "fünf vor halb drei" fällt ins Nachtfenster',
    text: 'morgen fünf vor halb drei Call',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 2, 25),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK2: "zehn nach halb drei" fällt ins Nachtfenster',
    text: 'morgen zehn nach halb drei Call',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 2, 40),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },

  // #688 AK3: Nachtfenster — Grundlage für `needsConfirmation` (unverändert, eigene
  // Tests in parse-task-input.test.ts). Die Feld-Konfidenz "Uhrzeit" (#691) kennt kein
  // Nachtfenster: jede aus dem Sprechzeitpunkt geratene Tageshälfte zählt, "um 6" also
  // ebenso wie "halb eins" — nur die ausgeschriebene Doppelpunkt-Zeit bleibt `high`.
  {
    signal: '#688 AK3: "halb eins" fällt ins Nachtfenster',
    text: 'morgen halb eins Mittagessen',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 0, 30),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK3: "um 6" liegt außerhalb des Nachtfensters, aber die Tageshälfte ist trotzdem geraten',
    text: 'morgen um 6 Sport',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 6, 0),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK3: "0:30" ist ausgeschrieben, nie geraten -> confidence high',
    text: 'morgen 0:30 Nachtschicht',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 0, 30),
      confidence: { time: { level: 'high' } },
    },
  },

  // #688 AK4: regionale Kurzformen ("viertel H"/"dreiviertel H" ohne vor/nach) —
  // Verwechslungsgefahr mit "viertel nach H", deshalb ein eigener Grundtext (#691).
  {
    signal: '#688 AK4: "dreiviertel zwölf" (regional)',
    text: 'morgen dreiviertel zwölf Abgabe',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 11, 45),
      confidence: { time: { level: 'guessed', reason: 'regionale Zeitangabe' } },
    },
  },
  {
    signal: '#688 AK4: "viertel zwölf" (regional)',
    text: 'morgen viertel zwölf Abgabe',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 11, 15),
      confidence: { time: { level: 'guessed', reason: 'regionale Zeitangabe' } },
    },
  },

  // #688 AK5: ein Tageszeitwort schlägt die Tageshälften-Heuristik immer — und macht
  // die Feld-Konfidenz "Uhrzeit" (#691) `high`, weil dann nichts mehr geraten ist.
  {
    signal: '#688 AK5: "morgens" bestätigt die Heuristik, Feld-Konfidenz bleibt high',
    text: 'morgen um 6 Uhr morgens Sport',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 6, 0),
      confidence: { time: { level: 'high' } },
    },
  },
  {
    signal: '#688 AK5: ohne Tageszeitwort entscheidet die Heuristik -> Feld-Konfidenz guessed',
    text: 'morgen um 8 Standup',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 8, 0),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK5: "abends" schlägt die Heuristik (sonst vormittags gelesen)',
    text: 'morgen um 8 abends Kino',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 20, 0),
      confidence: { time: { level: 'high' } },
    },
  },
  {
    signal: '#688 AK5: "nachmittags" schlägt die Heuristik, Zahlwort statt Ziffer',
    text: 'morgen um drei nachmittags Kaffee',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 15, 0),
      confidence: { time: { level: 'high' } },
    },
  },

  // #688 AK6: dieselbe Eingabe, zweiter Bezugspunkt (nachmittags gesprochen) -> andere
  // Tageshälfte. `now: NOW_AFTERNOON` statt einer zweiten Korpus-Datei. Beide ohne
  // Tageszeitwort, Feld-Konfidenz "Uhrzeit" also `guessed` an beiden Bezugspunkten.
  {
    signal: '#688 AK6: "halb acht", gesprochen um 15:00 -> Nachmittagslesart',
    text: 'morgen halb acht Frühstück',
    now: NOW_AFTERNOON,
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 19, 30),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },
  {
    signal: '#688 AK6: "um 8", gesprochen um 15:00 -> Nachmittagslesart',
    text: 'morgen um 8 Standup',
    now: NOW_AFTERNOON,
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 20, 0),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },

  // #689 AK1: Monatsname -> Datum ohne Uhrzeit bleibt task (kein Vokabular/Zeit-Signal).
  {
    signal: '#689 AK1: Monatsname "am 4. August"',
    text: 'am 4. August Zahnarzt',
    expect: { kind: 'task', dueAt: new Date(2024, 7, 4, 9, 0) },
  },

  // #689 AK2: relative Spannen.
  {
    signal: '#689 AK2: "in drei Tagen"',
    text: 'in drei Tagen Rechnung zahlen',
    expect: { kind: 'task', dueAt: new Date(2024, 0, 18, 9, 0) },
  },
  {
    signal: '#689 AK2: "in einer Woche"',
    text: 'in einer Woche nachfassen',
    expect: { kind: 'task', dueAt: new Date(2024, 0, 22, 9, 0) },
  },

  // #689 AK3: "nächsten" überspringt eine Woche gegenüber der bloßen Wochentagsform.
  {
    signal: '#689 AK3: "nächsten Dienstag" überspringt eine Woche',
    text: 'nächsten Dienstag Zahnarzt',
    expect: { kind: 'task', dueAt: new Date(2024, 0, 23, 9, 0) },
  },

  // #689 AK4: der Satz aus #620, die Begründung für den Modell-Parser — muss lokal fallen.
  // #691: gleich zwei geratene Felder in einem Satz — "nächsten" (eigener Grundtext,
  // Wochensprung) und die Tageshälfte von "viertel vor neun" (kein Tageszeitwort).
  {
    signal: '#689 AK4: "kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen"',
    text: 'kannst du mir für nächsten Dienstag viertel vor neun einen Zahnarzttermin einstellen',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 23, 8, 45),
      confidence: {
        date: { level: 'guessed', reason: '„nächsten" überspringt eine Woche' },
        time: { level: 'guessed', reason: 'Tageshälfte geraten' },
      },
    },
  },

  // #689 AK5: Tagesgrenze 04:00 — Nacht-Bezugspunkt Di 01:30, logischer Tag ist Mo.
  {
    signal: '#689 AK5: "morgen 14 Uhr" bleibt derselbe Kalendertag über die Tagesgrenze',
    text: 'morgen 14 Uhr Zahnarzt',
    now: NOW_NIGHT,
    // "14 Uhr" ist eine eindeutige 24-Stunden-Zeit — nie geraten (#691).
    expect: { kind: 'event', dueAt: new Date(2024, 0, 16, 14, 0), confidence: { time: { level: 'high' } } },
  },
  {
    signal: '#689 AK5: "heute noch" ist der logische, nicht der reale Kalendertag',
    text: 'heute noch Müll rausbringen',
    now: NOW_NIGHT,
    expect: { kind: 'task', dueAt: new Date(2024, 0, 15, 9, 0) },
  },
  {
    signal: '#689 AK5: "übermorgen" zählt ab dem logischen Tag',
    text: 'übermorgen Friseur anrufen',
    now: NOW_NIGHT,
    expect: { kind: 'task', dueAt: new Date(2024, 0, 17, 9, 0) },
  },
  {
    signal: '#689 AK5: Wochentag zählt ab dem logischen Tag',
    text: 'Dienstag 12 Uhr Zahnarzt',
    now: NOW_NIGHT,
    // "12 Uhr" ist der Zwölf-Fixpunkt (Mittag) — nie geraten, unabhängig vom Tageszeitwort.
    expect: { kind: 'event', dueAt: new Date(2024, 0, 16, 12, 0), confidence: { time: { level: 'high' } } },
  },
  {
    signal: '#689 AK5: reine Uhrzeit ohne Datum — "sonst morgen" ab dem logischen Tag',
    text: 'Zahnarzt um 8',
    now: NOW_NIGHT,
    // Kein Tageszeitwort -> die Tageshälfte kommt aus dem Sprechzeitpunkt (#691).
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 8, 0),
      confidence: { time: { level: 'guessed', reason: 'Tageshälfte geraten' } },
    },
  },

  // #689 AK6: Abhaken folgt dem logischen Tag (R6) bzw. dem genannten Datum, bis 7 Tage
  // rückwärts (R7) — logDate ist der Log-Tag, nie eine Fälligkeit.
  {
    signal: '#689 AK6: "Sport gemacht" hakt den logischen Tag ab, nicht den realen',
    text: 'Sport gemacht',
    now: NOW_NIGHT,
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
      logDate: '2024-01-15',
    },
  },
  {
    signal: '#689 AK6: "gestern Sport gemacht"',
    text: 'gestern Sport gemacht',
    now: NOW_NIGHT,
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
      logDate: '2024-01-14',
    },
  },
  {
    signal: '#689 AK6: "Sport für gestern abhaken"',
    text: 'Sport für gestern abhaken',
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
      logDate: '2024-01-14',
    },
  },
  {
    signal: '#689 AK6: "Sport für morgen abhaken" — Zukunft wird ignoriert',
    text: 'Sport für morgen abhaken',
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
      logDate: '2024-01-15',
    },
  },
  {
    signal: '#689 AK6: "Sport für den 1.1. abhaken" — mehr als 7 Tage zurück wird ignoriert',
    text: 'Sport für den 1.1. abhaken',
    expect: {
      kind: 'habit_check',
      habitId: 'h-sport',
      confidence: { habit: { level: 'high' } },
      logDate: '2024-01-15',
    },
  },

  // #691: Feld-Konfidenz — die Tabelle „Was als guessed gilt" (Ticket #691), je Zeile
  // mindestens ein Fall. Wo eine bestehende Zeile oben schon dieselbe Regel deckt
  // (Wochentag ohne Datum, keine Uhrzeit gesagt, Tageshälfte, regionale Zeitangabe),
  // steht hier kein Duplikat.
  {
    signal: '#691 AK1: "Dienstag um 3 Zahnarzt" -> Uhrzeit + Datum geraten, Titel sicher',
    text: 'Dienstag um 3 Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 3, 0),
      confidence: {
        time: { level: 'guessed', reason: 'Tageshälfte geraten' },
        date: { level: 'guessed', reason: 'Wochentag ohne Datum' },
        title: { level: 'high' },
      },
    },
  },
  {
    signal: '#691 AK1: "morgen 14:30 Zahnarzt" -> keine Markierung',
    text: 'morgen 14:30 Zahnarzt',
    expect: {
      kind: 'event',
      dueAt: new Date(2024, 0, 16, 14, 30),
      confidence: {
        time: { level: 'high' },
        date: { level: 'high' },
        title: { level: 'high' },
      },
    },
  },
  {
    signal: '#691: Datum ohne Jahr rollt ins nächste Jahr -> "Jahr ergänzt"',
    text: 'Jahresrückblick am 1.1.',
    expect: {
      kind: 'task',
      dueAt: new Date(2025, 0, 1, 9, 0),
      confidence: { date: { level: 'guessed', reason: 'Jahr ergänzt' } },
    },
  },
  {
    signal: '#691: Titel leer nach Abzug aller Spans -> "kein Titel erkannt"',
    text: 'morgen um 12',
    expect: {
      kind: 'event',
      confidence: { title: { level: 'guessed', reason: 'kein Titel erkannt' } },
    },
  },
  {
    signal: '#691: Abstand zwischen Sieger und Zweitem im Ranking unter 20 -> "Aufgabe oder Termin unklar"',
    text: 'erinnere mich an das Meeting',
    expect: {
      kind: 'task',
      confidence: { kind: { level: 'guessed', reason: 'Aufgabe oder Termin unklar' } },
    },
  },

  // #780 AK3/AK4: Routine-Intent-Wort ohne Erledigungsverb -> neue Gewohnheit, das
  // Intent-Wort verschwindet aus dem Namen (E1).
  {
    signal: '#780 AK3/AK4: "Routine Wasser trinken" -> neue Gewohnheit, Intent-Wort nicht im Namen',
    text: 'Routine Wasser trinken',
    expect: { kind: 'habit_check', habitId: null, newHabit: true, title: 'Wasser trinken' },
  },
  {
    signal: '#780 AK3: "Gewohnheit meditieren" -> gleichbedeutend',
    text: 'Gewohnheit meditieren',
    expect: { kind: 'habit_check', habitId: null, newHabit: true, title: 'meditieren' },
  },
  {
    signal: '#780 AK3: "neue Routine Wasser trinken" -> gleichbedeutend',
    text: 'neue Routine Wasser trinken',
    expect: { kind: 'habit_check', habitId: null, newHabit: true, title: 'Wasser trinken' },
  },
  // Gegenfall (E3): das Intent-Wort bei einer bestehenden Gewohnheit UND einem
  // Erledigungsverb bleibt das normale Abhaken -> keine zweite Gewohnheit.
  {
    signal: '#780 Gegenfall: "Routine Sport abhaken" bei vorhandener Gewohnheit -> hakt ab, legt nichts an',
    text: 'Routine Sport abhaken',
    expect: { kind: 'habit_check', habitId: 'h-sport', newHabit: false },
  },
  // E3: das Intent-Wort OHNE Erledigungsverb legt auch dann neu an, wenn eine
  // gleichnamige Gewohnheit schon existiert -> kein Verb, kein Abhaken-Recht.
  {
    signal: '#780 E3: "Routine Sport" ohne Verb bei vorhandener Gewohnheit -> trotzdem neue Gewohnheit',
    text: 'Routine Sport',
    expect: { kind: 'habit_check', habitId: null, newHabit: true, title: 'Sport' },
  },
  // AK6: Routinen-Modul aus -> der sichere Rückfall bleibt task, das Intent-Wort
  // bleibt unangetastet im Titel stehen (keine Titel-Bereinigung außerhalb von newHabit).
  {
    signal: '#780 AK6: "Routine Wasser trinken", Routinen-Modul aus -> bleibt Aufgabe',
    text: 'Routine Wasser trinken',
    allowedKinds: ['task', 'event'],
    expect: { kind: 'task', title: 'Routine Wasser trinken' },
  },
];
