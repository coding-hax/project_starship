/**
 * Bewusst enge, deterministische Grammatik für deutsche Freiform-Eingaben (kein NLU,
 * keine Dependency) — issue #47 Schnitt 1, auf Spans umgebaut in #687 (Teil 1 von 3 des
 * Parser-Umbaus, Epic #617). Verfahren (angelehnt an chrono-node/Duckling):
 *
 * 1. Kandidaten mit Span `{ start, end }` erzeugen — nie `text.slice()` und auf dem Rest
 *    weiterarbeiten (das koppelte jedes weitere Ergebnis an die Zweig-Reihenfolge).
 * 2. Überlappen zwei Kandidaten desselben Typs (z. B. "um 14" und "um 14 Uhr"), gewinnt
 *    der längere Span — das ist der Fix für den "Uhr bleibt im Titel"-Bug.
 * 3. Titel = Rohtext minus aller Spans (Datum, Zeit, Kommandopräfix, angrenzende
 *    Bindewörter), danach Rand-Trim. Keine Wort-Blacklist mehr.
 *
 * Erkannt wird:
 * - Relative Tage: "heute", "morgen", "übermorgen".
 * - Wochentage: "montag".."sonntag" -> nächstes zukünftiges Vorkommen (fällt der Name
 *   auf den heutigen Wochentag, zählt das als heute).
 * - Absolutes Datum: "am D.M." oder "D.M." (Jahr optional; ohne Jahr das nächste
 *   zukünftige Vorkommen).
 * - Uhrzeit — unabhängig von einem Datum gesucht (AC2): "um H", "um H:MM", "H Uhr",
 *   "HH:MM", plus ausgeschriebene Zahlen 1-12 ("um zwölf", "drei Uhr"). Ohne Treffer:
 *   Default 09:00 lokal, außer nur eine Uhrzeit ohne Datum wurde erkannt — dann "heute",
 *   wenn die Zeit noch in der Zukunft liegt, sonst "morgen" (AC2).
 * - Titel (R3): entfernt werden nur Kommandopräfixe am Satzanfang ("erstelle (einen/eine)
 *   …", "erinnere mich (an)", "neue aufgabe:", "aufgabe:", "bitte", "trag") und "Termin",
 *   wenn unmittelbar ein Datum-/Zeit-Span folgt — sowie Bindewörter ("am", "um", "für",
 *   "daran", "beim"), die direkt an einer Span-Grenze stehen. Eine explizite "Titel X"
 *   schlägt alles andere. Alles sonst bleibt stehen, auch "Termin"/"Aufgabe" mitten im Satz.
 *   Bleibt kein Titel übrig, bleibt er leer (AC5) — die Rohzeile wird nicht mehr Titel.
 *
 * Kein Anspruch auf "alles verstehen" — das Bestätigungs-Sheet bzw. der Undo-Toast
 * im Direkt-Pfad ist das Netz für alles, was diese Grammatik nicht trifft.
 */

export interface ParsedTaskInput {
  title: string;
  dueAt: string | null;
}

export interface Span {
  start: number;
  end: number;
}

interface Candidate<T> extends Span {
  value: T;
  specificity: number;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Längster Span gewinnt, bei Gleichstand der spezifischere (Ranken-Schritt des Verfahrens). */
function bestCandidate<T>(candidates: Candidate<T>[]): Candidate<T> | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestLen = best.end - best.start;
    const curLen = current.end - current.start;
    if (curLen !== bestLen) return curLen > bestLen ? current : best;
    return current.specificity > best.specificity ? current : best;
  });
}

/** Nur Whitespace/Satzzeichen zwischen zwei Positionen — keine weiteren Wörter dazwischen. */
function isPunctuationOnly(text: string, start: number, end: number): boolean {
  if (start > end) return false;
  return /^[\s,.;:!?]*$/.test(text.slice(start, end));
}

function isAdjacent(a: Span, b: Span, text: string): boolean {
  if (a.end <= b.start) return isPunctuationOnly(text, a.end, b.start);
  if (b.end <= a.start) return isPunctuationOnly(text, b.end, a.start);
  return false;
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
function wordPattern(pattern: string, flags = 'iu'): RegExp {
  return new RegExp(`${WORD_BEFORE}${pattern}${WORD_AFTER}`, flags);
}

// --- Datum -------------------------------------------------------------

const RELATIVE_DAYS: Record<string, number> = { heute: 0, morgen: 1, übermorgen: 2 };
// Date.getDay() order: 0 = Sonntag.
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];

// Kein `\b` am Ende: bei "4.8." (Standard-Schreibweise mit Punkt nach dem Monat, kein
// Jahr) liegt der zweite Punkt direkt vor Zeilenende — zwei Nicht-Wortzeichen bilden
// dort nie eine Wortgrenze, ein abschließendes `\b` würde diesen Fall nie treffen.
const ABSOLUTE_DATE_PATTERN = /\b(?:am\s+)?(\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?/giu;

interface DateValue {
  date: Date;
}

function findDateCandidate(text: string, now: Date): Candidate<DateValue> | null {
  const candidates: Candidate<DateValue>[] = [];

  for (const match of text.matchAll(ABSOLUTE_DATE_PATTERN)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3] ? Number(match[3]) : now.getFullYear();
    const date = new Date(year, month - 1, day);
    if (!match[3] && date < startOfDay(now)) date.setFullYear(date.getFullYear() + 1);
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date },
      specificity: 3,
    });
  }

  const relativePattern = wordPattern(`(${Object.keys(RELATIVE_DAYS).join('|')})`, 'giu');
  for (const match of text.matchAll(relativePattern)) {
    const key = match[1].toLowerCase();
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date: addDays(startOfDay(now), RELATIVE_DAYS[key]) },
      specificity: 2,
    });
  }

  const weekdayPattern = wordPattern(`(${WEEKDAYS.join('|')})`, 'giu');
  for (const match of text.matchAll(weekdayPattern)) {
    const targetDay = WEEKDAYS.indexOf(match[1].toLowerCase());
    const diff = (targetDay - now.getDay() + 7) % 7;
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date: addDays(startOfDay(now), diff) },
      specificity: 1,
    });
  }

  return bestCandidate(candidates);
}

// --- Uhrzeit -------------------------------------------------------------

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

interface TimeValue {
  hours: number;
  minutes: number;
}

function timeValueFromDigits(hours: string, minutes: string | undefined): TimeValue {
  return { hours: Number(hours), minutes: minutes ? Number(minutes) : 0 };
}

// Jede Form separat, statt einer Alternation — überlappende Treffer (z. B. "um 14" *und*
// "um 14 Uhr") werden über `bestCandidate` (längster Span gewinnt) aufgelöst, nicht über
// Zweig-Reihenfolge im Regex.
const DIGIT_TIME_PATTERNS: { pattern: RegExp; specificity: number }[] = [
  { pattern: /\bum\s+(\d{1,2})(?::(\d{2}))?\s*uhr\b/giu, specificity: 3 },
  { pattern: /\bum\s+(\d{1,2})(?::(\d{2}))?\b/giu, specificity: 2 },
  { pattern: /\b(\d{1,2})(?::(\d{2}))?\s*uhr\b/giu, specificity: 2 },
  { pattern: /\b(\d{1,2}):(\d{2})\b/g, specificity: 1 },
];

const WORD_TIME_PATTERNS: { pattern: RegExp; specificity: number }[] = [
  { pattern: new RegExp(`${WORD_BEFORE}um\\s+${WORD_NUMBER_GROUP}${WORD_AFTER}\\s*uhr${WORD_AFTER}`, 'giu'), specificity: 3 },
  { pattern: new RegExp(`${WORD_BEFORE}um\\s+${WORD_NUMBER_GROUP}${WORD_AFTER}`, 'giu'), specificity: 2 },
  { pattern: new RegExp(`${WORD_BEFORE}${WORD_NUMBER_GROUP}${WORD_AFTER}\\s*uhr${WORD_AFTER}`, 'giu'), specificity: 2 },
];

function findTimeCandidate(text: string): Candidate<TimeValue> | null {
  const candidates: Candidate<TimeValue>[] = [];

  for (const { pattern, specificity } of DIGIT_TIME_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      candidates.push({
        start: match.index!,
        end: match.index! + match[0].length,
        value: timeValueFromDigits(match[1], match[2]),
        specificity,
      });
    }
  }

  for (const { pattern, specificity } of WORD_TIME_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      candidates.push({
        start: match.index!,
        end: match.index! + match[0].length,
        value: { hours: WORD_NUMBERS[match[1].toLowerCase()], minutes: 0 },
        specificity,
      });
    }
  }

  return bestCandidate(candidates);
}

// --- Kommandopräfixe & Bindewörter (R3) -----------------------------------

const COMMAND_PREFIXES: RegExp[] = [
  /^erstelle\b(\s+(einen|eine)\b)?\s*/iu,
  /^erinnere\s+mich\b(\s+an\b)?\s*/iu,
  /^neue\s+aufgabe\b\s*:?\s*/iu,
  /^aufgabe\b\s*:\s*/iu,
  /^bitte\b\s+/iu,
  /^trag\b\s+/iu,
];

const CONNECTOR_WORDS = ['am', 'um', 'für', 'daran', 'beim'];

/** Kommandopräfixe können sich am Satzanfang aneinanderreihen ("erstelle" + "neue aufgabe"). */
function findCommandPrefixSpans(text: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (;;) {
    const remaining = text.slice(cursor);
    const match = COMMAND_PREFIXES.map((pattern) => remaining.match(pattern)).find(
      (candidate): candidate is RegExpMatchArray => candidate !== null && candidate[0].length > 0,
    );
    if (!match) break;
    spans.push({ start: cursor, end: cursor + match[0].length });
    cursor += match[0].length;
  }
  return spans;
}

/** "Termin" ist nur ein Kommandopräfix, wenn unmittelbar (Whitespace/Satzzeichen erlaubt,
 * kein weiteres Wort) ein Datum- oder Zeit-Span folgt — sonst bleibt es Titel-Text. */
function findTerminPrefixSpan(text: string, dateSpan: Span | null, timeSpan: Span | null): Span | null {
  const match = text.match(/^termin\b\s*/iu);
  if (!match) return null;
  const prefixEnd = match.index! + match[0].length;
  const nextSpanStart = [dateSpan, timeSpan]
    .filter((span): span is Span => span !== null)
    .map((span) => span.start)
    .sort((a, b) => a - b)[0];
  if (nextSpanStart === undefined) return null;
  if (!isPunctuationOnly(text, prefixEnd, nextSpanStart)) return null;
  return { start: 0, end: match[0].length };
}

function findConnectorSpans(text: string, anchors: Span[]): Span[] {
  if (anchors.length === 0) return [];
  const spans: Span[] = [];
  for (const word of CONNECTOR_WORDS) {
    const pattern = wordPattern(word, 'giu');
    for (const match of text.matchAll(pattern)) {
      const candidate: Span = { start: match.index!, end: match.index! + match[0].length };
      if (anchors.some((anchor) => overlaps(anchor, candidate))) continue;
      if (anchors.some((anchor) => isAdjacent(candidate, anchor, text))) spans.push(candidate);
    }
  }
  return spans;
}

// --- Explizite Titelangabe -------------------------------------------------

const EXPLICIT_TITLE_PATTERN = /\btitel\s+([^]+)$/iu;

function edgeTrim(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '')
    .trim();
}

function findExplicitTitle(text: string): string | null {
  const match = text.match(EXPLICIT_TITLE_PATTERN);
  if (!match) return null;
  const title = edgeTrim(match[1]);
  return title || null;
}

function removeSpans(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const span of sorted) {
    result += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  result += text.slice(cursor);
  return result;
}

// --- Zusammenführung -------------------------------------------------------

export interface DateTimeSlot {
  date: Date | null;
  hasExplicitTime: boolean;
}

export interface TextAnalysis extends DateTimeSlot {
  title: string;
}

/** Uhrzeit ohne Datum: "heute", wenn sie noch in der Zukunft liegt, sonst "morgen" (AC2). */
function resolveTimeOnlyDate(time: TimeValue, now: Date): Date {
  const candidate = startOfDay(now);
  candidate.setHours(time.hours, time.minutes, 0, 0);
  return candidate > now ? candidate : addDays(candidate, 1);
}

/**
 * Die eine Stelle, die Datum, Uhrzeit und Titel gemeinsam aus einer Freitext-Eingabe
 * gewinnt — von `parseTaskInput` (Aufgaben-FAB) und `recognizeLocally` (#621,
 * Erfassungs-Klassifikator) gleichermaßen benutzt, damit R3 überall identisch gilt.
 */
export function analyzeText(text: string, now: Date = new Date()): TextAnalysis {
  const dateCandidate = findDateCandidate(text, now);
  const timeCandidate = findTimeCandidate(text);

  let date: Date | null = null;
  const hasExplicitTime = timeCandidate !== null;
  if (dateCandidate) {
    date = new Date(dateCandidate.value.date);
    if (timeCandidate) {
      date.setHours(timeCandidate.value.hours, timeCandidate.value.minutes, 0, 0);
    } else {
      date.setHours(9, 0, 0, 0);
    }
  } else if (timeCandidate) {
    date = resolveTimeOnlyDate(timeCandidate.value, now);
  }

  const explicitTitle = findExplicitTitle(text);
  if (explicitTitle !== null) {
    return { date, hasExplicitTime, title: explicitTitle };
  }

  const dateSpan = dateCandidate ? { start: dateCandidate.start, end: dateCandidate.end } : null;
  const timeSpan = timeCandidate ? { start: timeCandidate.start, end: timeCandidate.end } : null;
  const anchors = [dateSpan, timeSpan].filter((span): span is Span => span !== null);

  const prefixSpans = findCommandPrefixSpans(text);
  const terminSpan =
    prefixSpans.length === 0 ? findTerminPrefixSpan(text, dateSpan, timeSpan) : null;
  const connectorSpans = findConnectorSpans(text, anchors);

  const removalSpans = [...prefixSpans, ...(terminSpan ? [terminSpan] : []), ...anchors, ...connectorSpans];
  const title = edgeTrim(removeSpans(text, removalSpans));
  return { date, hasExplicitTime, title };
}

export function parseTaskInput(text: string, now: Date = new Date()): ParsedTaskInput {
  const { date, title } = analyzeText(text, now);
  return { title, dueAt: date ? date.toISOString() : null };
}

/**
 * Datum-/Uhrzeit-Slot allein, ohne Titel-Bereinigung — der Erkennungs-Baustein, den
 * issue #621 (Klassifikator) wiederverwendet statt die Grammatik zu duplizieren.
 */
export function extractDateTimeSlot(text: string, now: Date = new Date()): DateTimeSlot {
  const { date, hasExplicitTime } = analyzeText(text, now);
  return { date, hasExplicitTime };
}
