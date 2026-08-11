/**
 * Bewusst enge, deterministische Grammatik für deutsche Freiform-Eingaben (kein NLU,
 * keine Dependency) — issue #47 Schnitt 1. Erkannt wird:
 *
 * - Relative Tage: "heute", "morgen", "übermorgen".
 * - Wochentage: "montag".."sonntag" -> nächstes zukünftiges Vorkommen (fällt der Name
 *   auf den heutigen Wochentag, zählt das als heute).
 * - Absolutes Datum: "am D.M." oder "D.M." (Jahr optional; ohne Jahr das nächste
 *   zukünftige Vorkommen).
 * - Uhrzeit — nur ausgewertet, wenn zuvor ein Datum erkannt wurde: "um H", "um H:MM",
 *   "H Uhr", "HH:MM". Ohne Uhrzeit-Treffer: Default 09:00 lokal.
 * - Titel: Rohtext minus erkannte Datum-/Zeit-Tokens minus Aktions-/Füllwörter
 *   ("erinnere mich an", "erstelle", "neue aufgabe", "aufgabe", "termin"), getrimmt.
 *   Bleibt danach kein Titel übrig, ist die gesamte Rohzeile der Titel und `dueAt`
 *   bleibt `null` (fällt auf das "kein Datum"-Verhalten zurück).
 *
 * Kein Anspruch auf "alles verstehen" — das Bestätigungs-Sheet bzw. der Undo-Toast
 * im Direkt-Pfad ist das Netz für alles, was diese Grammatik nicht trifft.
 */

export interface ParsedTaskInput {
  title: string;
  dueAt: string | null;
}

interface Extracted {
  match: RegExpMatchArray;
  remaining: string;
}

function extract(text: string, pattern: RegExp): Extracted | null {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return null;
  const remaining = text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length);
  return { match, remaining };
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// `\b` only recognizes ASCII word characters — it fails right at the leading "ü" of
// "übermorgen" (neither side of that position counts as \w), silently refusing to
// match the whole word. A Unicode-aware boundary via lookaround fixes that.
const WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;

const RELATIVE_DAY_PATTERN = new RegExp(
  `${WORD_BEFORE}(heute|übermorgen|morgen)${WORD_AFTER}`,
  'iu',
);
const RELATIVE_DAYS: Record<string, number> = { heute: 0, morgen: 1, übermorgen: 2 };

// Date.getDay() order: 0 = Sonntag.
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const WEEKDAY_PATTERN = new RegExp(`${WORD_BEFORE}(${WEEKDAYS.join('|')})${WORD_AFTER}`, 'iu');

// Kein `\b` am Ende: bei "4.8." (Standard-Schreibweise mit Punkt nach dem Monat, kein
// Jahr) liegt der zweite Punkt direkt vor Zeilenende — zwei Nicht-Wortzeichen bilden
// dort nie eine Wortgrenze, ein abschließendes `\b` würde diesen Fall nie treffen.
const ABSOLUTE_DATE_PATTERN = /\b(?:am\s+)?(\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?/i;

const TIME_PATTERNS = [
  /\bum\s+(\d{1,2})(?::(\d{2}))?\b/i,
  /\b(\d{1,2})(?::(\d{2}))?\s*uhr\b/i,
  /\b(\d{1,2}):(\d{2})\b/,
];

// Ausgeschriebene Uhrzeiten 1-12 — Diktat sagt "um zwölf", nicht "um 12". Bewusst nur
// bis zwölf (AC8): 13-24 ausgeschrieben ist selten und bliebe sonst beim Default 09:00,
// was dokumentiert und akzeptiert ist (kein Scope-Creep, Regel 2).
const WORD_NUMBERS: Record<string, number> = {
  eins: 1,
  ein: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
};
const WORD_NUMBER_GROUP = `(${Object.keys(WORD_NUMBERS).join('|')})`;

const WORD_TIME_PATTERNS = [
  new RegExp(`${WORD_BEFORE}um\\s+${WORD_NUMBER_GROUP}${WORD_AFTER}`, 'iu'),
  new RegExp(`${WORD_BEFORE}${WORD_NUMBER_GROUP}${WORD_AFTER}\\s*uhr${WORD_AFTER}`, 'iu'),
];

const FILLER_PATTERN = /\b(erinnere mich an|erstelle|neue aufgabe|aufgabe|termin)\b/gi;

function resolveDate(text: string, now: Date): { date: Date | null; remaining: string } {
  const absolute = extract(text, ABSOLUTE_DATE_PATTERN);
  if (absolute) {
    const day = Number(absolute.match[1]);
    const month = Number(absolute.match[2]);
    const year = absolute.match[3] ? Number(absolute.match[3]) : now.getFullYear();
    const date = new Date(year, month - 1, day);
    if (!absolute.match[3] && date < startOfDay(now)) {
      date.setFullYear(date.getFullYear() + 1);
    }
    return { date, remaining: absolute.remaining };
  }

  const relative = extract(text, RELATIVE_DAY_PATTERN);
  if (relative) {
    const key = relative.match[1].toLowerCase();
    return { date: addDays(startOfDay(now), RELATIVE_DAYS[key]), remaining: relative.remaining };
  }

  const weekday = extract(text, WEEKDAY_PATTERN);
  if (weekday) {
    const targetDay = WEEKDAYS.indexOf(weekday.match[1].toLowerCase());
    const diff = (targetDay - now.getDay() + 7) % 7;
    return { date: addDays(startOfDay(now), diff), remaining: weekday.remaining };
  }

  return { date: null, remaining: text };
}

function resolveTime(text: string): {
  hours: number;
  minutes: number;
  remaining: string;
  explicit: boolean;
} {
  for (const pattern of TIME_PATTERNS) {
    const found = extract(text, pattern);
    if (found) {
      return {
        hours: Number(found.match[1]),
        minutes: found.match[2] ? Number(found.match[2]) : 0,
        remaining: found.remaining,
        explicit: true,
      };
    }
  }
  for (const pattern of WORD_TIME_PATTERNS) {
    const found = extract(text, pattern);
    if (found) {
      return {
        hours: WORD_NUMBERS[found.match[1].toLowerCase()],
        minutes: 0,
        remaining: found.remaining,
        explicit: true,
      };
    }
  }
  return { hours: 9, minutes: 0, remaining: text, explicit: false };
}

export function cleanTitle(text: string): string {
  return text
    .replace(FILLER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '')
    .trim();
}

/**
 * Datum-/Uhrzeit-Slot allein, ohne Titel-Bereinigung — der Erkennungs-Baustein, den
 * issue #621 (Klassifikator) wiederverwendet statt die Grammatik zu duplizieren.
 */
export interface DateTimeSlot {
  date: Date | null;
  hasExplicitTime: boolean;
  remaining: string;
}

export function extractDateTimeSlot(text: string, now: Date = new Date()): DateTimeSlot {
  const { date, remaining: afterDate } = resolveDate(text, now);

  if (!date) {
    return { date: null, hasExplicitTime: false, remaining: afterDate };
  }

  const { hours, minutes, remaining: afterTime, explicit } = resolveTime(afterDate);
  date.setHours(hours, minutes, 0, 0);
  return { date, hasExplicitTime: explicit, remaining: afterTime };
}

export function parseTaskInput(text: string, now: Date = new Date()): ParsedTaskInput {
  const { date, remaining } = extractDateTimeSlot(text, now);
  const title = cleanTitle(remaining);

  if (!title) {
    return { title: text.trim(), dueAt: null };
  }

  return { title, dueAt: date ? date.toISOString() : null };
}
