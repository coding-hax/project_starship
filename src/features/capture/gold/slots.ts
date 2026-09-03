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

// --- Gesprochene Sprache ---------------------------------------------------

/**
 * Sprechköpfe, die **rückstandsfrei** verschwinden: was danach steht, ist der Titel.
 * Genau das macht sie generierbar — der Sollwert ist der eingesetzte Titel-Slot.
 *
 * Aufgenommen ist nur, was ein Mensch so diktiert. Köpfe, bei denen ein Objektwort im
 * Titel stehen bleibt („erstell mir einen Termin für Mittwoch" → „Termin"), gehören
 * nicht hierher, sondern in die kuratierte Schicht.
 */
export const SPOKEN_HEADS = [
  // Diktierte Kommandos mit Trenner
  'Mach mir ne Notiz:', 'Mach mir eine Notiz:', 'Mach eine Notiz:',
  'Setz mir das mal auf die Liste:', 'Setz das auf die Liste:', 'Pack auf meine Liste:',
  'Schreib auf:', 'Schreib mir auf:', 'Schreib bitte auf:',
  'Trag ein:', 'Trag mir ein:', 'Trag mir bitte ein:',
  'Gib mir eine Erinnerung:', 'Erinnere mich an:', 'Erinner mich an:',
  'Notier dir:', 'Notiere:', 'Notier mir:',
  'Merk dir:', 'Vermerk:', 'Leg eine Aufgabe an:', 'Erstelle eine Aufgabe:',
  'Füg hinzu:', 'Nimm auf:',
  // Höfliche Bitten
  'Kannst du mir notieren:', 'Kannst du mir bitte aufschreiben:',
  'Könntest du mir eintragen:', 'Kannst du bitte notieren:',
  // Etiketten
  'Neue Aufgabe:', 'Aufgabe:', 'Todo:', 'Nicht vergessen:', 'Denk dran:',
  'Merken:', 'Wichtig:',
];

/**
 * Aussagerahmen — kein Befehl, sondern wie man über eine Aufgabe redet. Vertragen im
 * Gegensatz zu den Köpfen oben eine Zeitangabe zwischen Rahmen und Titel
 * („ich muss morgen Milch kaufen").
 */
export const STATEMENT_HEADS = [
  'Ich muss', 'Ich muss noch', 'Ich müsste', 'Ich müsste noch',
  'Ich sollte', 'Ich sollte mal', 'Ich sollte mal wieder',
  'Ich will', 'Ich will noch', 'Ich möchte', 'Ich möchte noch',
  'Ich darf nicht vergessen', 'Ich hab noch vor',
  'Bitte', 'Unbedingt', 'Am besten',
];

/** Zögern und Gesprächspartikel am Satzanfang — reines Rauschen vor dem Inhalt. */
export const HESITATION_PREFIXES = [
  'Also ähm,', 'Also,', 'Ja also,', 'Äh,', 'Ähm,', 'Naja,', 'Okay,', 'Hm,',
  'Ach ja,', 'Übrigens,',
];

/**
 * Telegrammstil: „Mo 14 Uhr Zahnarzt", „Fr 19h Kino".
 *
 * Anders als die Wochentage oben zählt hier **heute mit** — das ist die Regel des
 * Bestandsparsers („ein Wochentag, der auf heute fällt, zählt als heute",
 * parse-task-input.test.ts). Der Bezugspunkt ist ein Montag, „Mo" meint also den
 * 15.01. selbst.
 */
export const WEEKDAY_ABBREVIATION_SLOTS: WhenSlot[] = [
  ['Mo', 1], ['Di', 2], ['Mi', 3], ['Do', 4], ['Fr', 5], ['Sa', 6], ['So', 0],
].map(([label, dow]) => ({
  text: label as string,
  category: 'Telegramm-Wochentag',
  resolve: (now: Date) => {
    const d = new Date(now);
    d.setDate(d.getDate() + (((dow as number) - now.getDay() + 7) % 7));
    d.setHours(DEFAULT_HOUR, 0, 0, 0);
    return d;
  },
}));

/** Uhrzeit im Telegrammstil — „19h" statt „19 Uhr". */
export const SHORT_TIME_SLOTS: TimeSlot[] = [
  { text: '7h', category: 'Telegramm-Uhrzeit', hours: 7, minutes: 0 },
  { text: '9h', category: 'Telegramm-Uhrzeit', hours: 9, minutes: 0 },
  { text: '14h', category: 'Telegramm-Uhrzeit', hours: 14, minutes: 0 },
  { text: '17h', category: 'Telegramm-Uhrzeit', hours: 17, minutes: 0 },
  { text: '19h', category: 'Telegramm-Uhrzeit', hours: 19, minutes: 0 },
  { text: '20h', category: 'Telegramm-Uhrzeit', hours: 20, minutes: 0 },
];

// --- Schwierige Satzkonstruktionen -----------------------------------------

/**
 * Zeitspannen: ein Termin, zwei genannte Uhrzeiten. Gemeint ist der Anfang — das
 * Ende ist im Korpus bewusst nicht geprüft, weil `endsAt` beim Erfassen noch nicht
 * gesetzt wird.
 */
export interface TimeRangeSlot extends TimeSlot {
  /** Genanntes Ende — landet als `endAt` im Draft und als `endsAt` am Termin. */
  endHours: number;
  endMinutes: number;
}

export const TIME_RANGE_SLOTS: TimeRangeSlot[] = [
  { text: 'von 9 bis 11 Uhr', category: 'Zeitspanne', hours: 9, minutes: 0, endHours: 11, endMinutes: 0 },
  { text: 'von 14 bis 16 Uhr', category: 'Zeitspanne', hours: 14, minutes: 0, endHours: 16, endMinutes: 0 },
  { text: 'zwischen 10 und 12 Uhr', category: 'Zeitspanne', hours: 10, minutes: 0, endHours: 12, endMinutes: 0 },
  { text: 'zwischen 15 und 17 Uhr', category: 'Zeitspanne', hours: 15, minutes: 0, endHours: 17, endMinutes: 0 },
  { text: '9-17 Uhr', category: 'Zeitspanne', hours: 9, minutes: 0, endHours: 17, endMinutes: 0 },
  { text: '13-15 Uhr', category: 'Zeitspanne', hours: 13, minutes: 0, endHours: 15, endMinutes: 0 },
  { text: '8 bis 10 Uhr', category: 'Zeitspanne', hours: 8, minutes: 0, endHours: 10, endMinutes: 0 },
  { text: 'von 18:30 bis 20 Uhr', category: 'Zeitspanne', hours: 18, minutes: 30, endHours: 20, endMinutes: 0 },
];

/** Wiederholungsausdrücke samt erwartetem `RecurrenceValue`. */
export interface RecurrenceSlot {
  text: string;
  category: string;
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  byWeekday?: number[];
}

export const RECURRENCE_SLOTS: RecurrenceSlot[] = [
  { text: 'Jeden Montag', category: 'Wiederholung', freq: 'weekly', interval: 1, byWeekday: [1] },
  { text: 'Jeden Freitag', category: 'Wiederholung', freq: 'weekly', interval: 1, byWeekday: [5] },
  { text: 'Jeden zweiten Montag', category: 'Wiederholung', freq: 'weekly', interval: 2, byWeekday: [1] },
  { text: 'Immer freitags', category: 'Wiederholung', freq: 'weekly', interval: 1, byWeekday: [5] },
  { text: 'Immer mittwochs', category: 'Wiederholung', freq: 'weekly', interval: 1, byWeekday: [3] },
  { text: 'Werktags', category: 'Wiederholung', freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] },
  { text: 'Täglich', category: 'Wiederholung', freq: 'daily', interval: 1 },
  { text: 'Jeden Tag', category: 'Wiederholung', freq: 'daily', interval: 1 },
  { text: 'Alle drei Tage', category: 'Wiederholung', freq: 'daily', interval: 3 },
  { text: 'Jede Woche', category: 'Wiederholung', freq: 'weekly', interval: 1 },
  { text: 'Alle zwei Wochen', category: 'Wiederholung', freq: 'weekly', interval: 2 },
  { text: 'Wöchentlich', category: 'Wiederholung', freq: 'weekly', interval: 1 },
  { text: 'Monatlich', category: 'Wiederholung', freq: 'monthly', interval: 1 },
  { text: 'Jeden Monat', category: 'Wiederholung', freq: 'monthly', interval: 1 },
  { text: 'Jährlich', category: 'Wiederholung', freq: 'yearly', interval: 1 },
];
