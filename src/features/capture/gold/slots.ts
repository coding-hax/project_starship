import { DEFAULT_HOUR } from './types';

/**
 * Slot-Werte für die generierte Korpusschicht — mit **eigener** Referenz-Auflösung.
 *
 * Diese Datei darf nichts aus `parse-task-input.ts` importieren. Käme die Soll-Auflösung
 * aus dem Parser, prüfte das Korpus den Parser gegen sich selbst und wäre wertlos.
 *
 * Aufgenommen wird nur, was **eindeutig** ist. Alles, worüber man streiten kann
 * („halb acht" ohne Tageszeit, „nächste Woche", „am Montag" an einem Montag), gehört
 * in die kuratierte Schicht, wo ein Mensch den Sollwert bestimmt hat.
 */

export interface WhenSlot {
  text: string;
  category: string;
  /** Kalendertag; Uhrzeit setzt der Generator (DEFAULT_HOUR oder ein TimeSlot). */
  resolve: (now: Date) => Date;
}

export interface TimeSlot {
  /** Wie es im Satz steht, ohne führendes „um". */
  text: string;
  category: string;
  hours: number;
  minutes: number;
}

function addDays(now: Date, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(DEFAULT_HOUR, 0, 0, 0);
  return d;
}

/** Nächstes Auftreten des Wochentags, echt in der Zukunft (heute zählt nicht). */
function nextWeekday(now: Date, dow: number, skipWeek = false): Date {
  let delta = (dow - now.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(now, delta + (skipWeek ? 7 : 0));
}

function onDate(now: Date, day: number, month: number): Date {
  const d = new Date(now);
  d.setMonth(month - 1, day);
  d.setHours(DEFAULT_HOUR, 0, 0, 0);
  return d;
}

const WEEKDAYS: [string, number][] = [
  ['Dienstag', 2],
  ['Mittwoch', 3],
  ['Donnerstag', 4],
  ['Freitag', 5],
  ['Samstag', 6],
  ['Sonntag', 0],
];

export const WHEN_SLOTS: WhenSlot[] = [
  { text: 'heute', category: 'Datum relativ', resolve: (n) => addDays(n, 0) },
  { text: 'morgen', category: 'Datum relativ', resolve: (n) => addDays(n, 1) },
  { text: 'übermorgen', category: 'Datum relativ', resolve: (n) => addDays(n, 2) },
  { text: 'in zwei Tagen', category: 'Datum Spanne', resolve: (n) => addDays(n, 2) },
  { text: 'in drei Tagen', category: 'Datum Spanne', resolve: (n) => addDays(n, 3) },
  { text: 'in fünf Tagen', category: 'Datum Spanne', resolve: (n) => addDays(n, 5) },
  { text: 'in 10 Tagen', category: 'Datum Spanne', resolve: (n) => addDays(n, 10) },
  { text: 'in einer Woche', category: 'Datum Spanne', resolve: (n) => addDays(n, 7) },
  { text: 'in zwei Wochen', category: 'Datum Spanne', resolve: (n) => addDays(n, 14) },
  // Wochentage: der Bezugspunkt ist Montag, deshalb ist keiner davon der heutige Tag.
  ...WEEKDAYS.map(([name, dow]): WhenSlot => ({
    text: `am ${name}`,
    category: 'Wochentag',
    resolve: (n) => nextWeekday(n, dow),
  })),
  // „nächsten X" überspringt eine Woche — dokumentierte Konvention des Bestandsparsers.
  ...WEEKDAYS.slice(0, 3).map(([name, dow]): WhenSlot => ({
    text: `nächsten ${name}`,
    category: 'Wochentag nächster',
    resolve: (n) => nextWeekday(n, dow, true),
  })),
  { text: 'am 3. März', category: 'Datum absolut', resolve: (n) => onDate(n, 3, 3) },
  { text: 'am 20. Februar', category: 'Datum absolut', resolve: (n) => onDate(n, 20, 2) },
  { text: 'am 1. April', category: 'Datum absolut', resolve: (n) => onDate(n, 1, 4) },
  { text: 'am 20.02.', category: 'Datum absolut', resolve: (n) => onDate(n, 20, 2) },
  { text: 'am 7.3.', category: 'Datum absolut', resolve: (n) => onDate(n, 7, 3) },
  { text: 'am 31.01.', category: 'Datum absolut', resolve: (n) => onDate(n, 31, 1) },
];

export const TIME_SLOTS: TimeSlot[] = [
  // 24h-Notation — kann nichts anderes heißen.
  { text: '7:42', category: 'Uhrzeit exakt', hours: 7, minutes: 42 },
  { text: '8:15', category: 'Uhrzeit exakt', hours: 8, minutes: 15 },
  { text: '11:30', category: 'Uhrzeit exakt', hours: 11, minutes: 30 },
  { text: '14:45', category: 'Uhrzeit exakt', hours: 14, minutes: 45 },
  { text: '18:05', category: 'Uhrzeit exakt', hours: 18, minutes: 5 },
  { text: '20:30', category: 'Uhrzeit exakt', hours: 20, minutes: 30 },
  // Volle Stunden ab 13 — die 24h-Lesart ist die einzig mögliche.
  { text: '13 Uhr', category: 'Uhrzeit voll', hours: 13, minutes: 0 },
  { text: '14 Uhr', category: 'Uhrzeit voll', hours: 14, minutes: 0 },
  { text: '16 Uhr', category: 'Uhrzeit voll', hours: 16, minutes: 0 },
  { text: '17 Uhr', category: 'Uhrzeit voll', hours: 17, minutes: 0 },
  { text: '19 Uhr', category: 'Uhrzeit voll', hours: 19, minutes: 0 },
  { text: '20 Uhr', category: 'Uhrzeit voll', hours: 20, minutes: 0 },
  // Kleine Stunden nur mit Tageszeitwort — sonst wäre die Hälfte strittig.
  { text: '8 Uhr morgens', category: 'Uhrzeit mit Tageszeit', hours: 8, minutes: 0 },
  { text: '7 Uhr früh', category: 'Uhrzeit mit Tageszeit', hours: 7, minutes: 0 },
  { text: '10 Uhr vormittags', category: 'Uhrzeit mit Tageszeit', hours: 10, minutes: 0 },
  { text: '9 Uhr abends', category: 'Uhrzeit mit Tageszeit', hours: 21, minutes: 0 },
];

/** Titel = exakt dieser String. Kein Wort darin darf ein Datums- oder Zeitsignal sein. */
export const TASK_TITLES = [
  'Milch kaufen', 'Müll rausbringen', 'Rechnung bezahlen', 'Oma anrufen',
  'Steuererklärung machen', 'Fahrrad reparieren lassen', 'Wäsche waschen',
  'Katzenfutter kaufen', 'Blumen gießen', 'Auto tanken', 'Fenster putzen',
  'Paket abholen', 'Vertrag kündigen', 'Reifen wechseln lassen', 'Küche putzen',
  'Brief zur Post bringen', 'Rasen mähen', 'Geschirrspüler ausräumen',
  'Geschenk für Lisa besorgen',
  'Mail an Thomas schreiben', 'Bericht fertig schreiben', 'Rechnung an den Kunden stellen',
  'Passwort ändern', 'Rückgabe verschicken', 'Amt anrufen',
  'Bücher zurückbringen', 'Kaffee nachbestellen', 'Handyvertrag prüfen',
  'Wohnung aufräumen',
];

export const EVENT_TITLES = [
  'Zahnarzt', 'Meeting mit dem Team', 'Kino mit Anna', 'Abendessen mit Lisa',
  'Vorstellungsgespräch', 'Konzert', 'Elternabend', 'Physiotherapie',
  'Zug nach Hamburg', 'Flug nach Wien', 'Teamrunde', 'Vortrag von Frau Berger',
  'Arzttermin', 'Impftermin', 'Sprechstunde',
  // Mit Schlüsselwort — nur diese sollen als Termin landen (Entscheidung 03.09.26).
  'Termin mit Anna', 'Meeting mit dem Team',
  'Treffen mit Jonas', 'Termin im Büro',
];

export const ROUTINE_VERBS = ['gemacht', 'erledigt', 'abgehakt', 'geschafft'];

/**
 * Sprechrahmen — reine Sprechakte, die definitionsgemäß nicht in den Titel gehören.
 * Aufgenommen ist nur, was den Kern **unflektiert** stehen lässt („Nicht vergessen: X"),
 * damit der Sollwert per Konstruktion feststeht. Alles, was den Kern umbaut
 * („erinnere mich daran, den Müll rauszubringen"), gehört in die kuratierte Schicht.
 */
export const FRAME_PREFIXES = [
  'Nicht vergessen:', 'Aufgabe:', 'Neue Aufgabe:', 'Todo:', 'Erinnere mich an:',
  'Bitte', 'Ich muss noch', 'Ich sollte', 'Ich will noch', 'Erstelle eine Aufgabe:',
  'Trag ein:', 'Kannst du mir eintragen:', 'Merken:', 'Unbedingt',
];

/** Nachgestellter Rahmen — „… nicht vergessen". */
export const FRAME_SUFFIXES = ['nicht vergessen', 'nicht vergessen!'];

/** Präpositionen vor einer Datumsangabe. Sie gehören zum Datum, nicht zum Titel. */
export const DATE_PREPOSITIONS = ['bis', 'bis spätestens', 'spätestens', 'ab'];
