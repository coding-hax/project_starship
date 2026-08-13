/**
 * Bewusst enge, deterministische Grammatik für deutsche Freiform-Eingaben (kein NLU,
 * keine Dependency) — issue #47 Schnitt 1, auf Spans umgebaut in #687 (Teil 1 von 3 des
 * Parser-Umbaus, Epic #617), um Zeigerzeit + Tageshälften erweitert in #688 (Teil 2 von 3).
 * Verfahren (angelehnt an chrono-node/Duckling):
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
 * - Zeigerzeit (R1, #688): "halb H", "viertel nach/vor H", "M vor/nach H",
 *   "M vor/nach halb H" sowie die regionalen Kurzformen "viertel H"/"dreiviertel H".
 *   Jede mehrdeutige Stunde (1-12, keine Doppelpunkt-Schreibweise, keine Zahl ab 13)
 *   bekommt danach eine Tageshälfte (R2): ein Tageszeitwort ("morgens" … "nachts")
 *   direkt an der Uhrzeit schlägt immer; sonst entscheidet, ob `now` vor oder nach
 *   12:00 liegt. Maßgeblich für diese Entscheidung ist die *genannte* Stunde, nicht
 *   die aufgelöste ("viertel vor neun" richtet sich nach der Neun). Eine so geratene
 *   Zeit zwischen 00:00 und 05:59, oder eine der beiden regionalen Kurzformen, setzt
 *   `needsConfirmation` — die Bestätigung, die der Aufgaben-Pfad sonst per
 *   Direkt-Erfassung überspringen würde, bleibt dann trotzdem stehen.
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
  needsConfirmation: boolean;
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
  /** R2 Regel 5 + AK4: eine in den Nachtfenster (00:00-05:59) geratene Tageshälfte oder
   * eine regionale Kurzform — der Aufgaben-Pfad zeigt dann das Bestätigungs-Sheet, auch
   * wenn "ohne Bestätigung direkt anlegen" an ist. */
  needsConfirmation: boolean;
}

// Zahlwörter für Minutenangaben in der Zeigerzeit-Grammatik (R1, #688) — bewusst eine
// eigene, größere Tabelle statt WORD_NUMBERS zu erweitern: dessen Elf-Uhr-Grenze
// (AC8, #47 — "13-24 ausgeschrieben bliebe sonst beim Default 09:00") gilt weiter
// unverändert für die einfachen "um H"/"H Uhr"-Formen.
const ZEIGERZEIT_MINUTE_WORDS: Record<string, number> = {
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
  dreizehn: 13,
  vierzehn: 14,
  fünfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
  zwanzig: 20,
  einundzwanzig: 21,
  zweiundzwanzig: 22,
  dreiundzwanzig: 23,
  vierundzwanzig: 24,
  fünfundzwanzig: 25,
};
const HOUR_TOKEN = `(\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;
const MINUTE_TOKEN = `(\\d{1,2}|${Object.keys(ZEIGERZEIT_MINUTE_WORDS).join('|')})`;

function resolveHourToken(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : WORD_NUMBERS[token.toLowerCase()];
}

function resolveMinuteToken(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : ZEIGERZEIT_MINUTE_WORDS[token.toLowerCase()];
}

// Tageszeitwörter (R2 Regel 1) — schlagen die Vormittags/Nachmittags-Heuristik immer,
// unabhängig davon, welche Seite der Uhrzeit sie stehen.
const DAY_PARTS: Record<string, boolean> = {
  morgens: false,
  früh: false,
  vormittags: false,
  mittags: true,
  nachmittags: true,
  abends: true,
  nachts: false,
};
const DAY_PART_PATTERN = wordPattern(`(${Object.keys(DAY_PARTS).join('|')})`, 'giu');

/** Ein Tageszeitwort unmittelbar vor oder nach der Uhrzeit — Satzzeichen dazwischen
 * erlaubt, kein weiteres Wort (dieselbe Nachbarschafts-Regel wie bei Bindewörtern). */
function findAdjacentDayPart(text: string, span: Span): { span: Span; isPM: boolean } | null {
  for (const match of text.matchAll(DAY_PART_PATTERN)) {
    const candidate: Span = { start: match.index!, end: match.index! + match[0].length };
    if (overlaps(candidate, span)) continue;
    if (isAdjacent(candidate, span, text)) {
      return { span: candidate, isPM: DAY_PARTS[match[1].toLowerCase()] };
    }
  }
  return null;
}

interface RawHourMatch extends Span {
  /** Stunde, wie sie mehrdeutig (1-12) gesprochen wurde — entscheidet über die
   * Tageshälfte (R2 Regel 4: die *genannte* Stunde, nicht die aufgelöste). `null`
   * heißt: schon eindeutig (Doppelpunkt-Schreibweise oder Stunde ab 13, R2 Regel 3) —
   * keine Tageshälften-Auflösung, nie "geraten". */
  namedHour: number | null;
  /** Stunde vor Anwendung der Tageshälfte — bei "vor"/"halb"-Formen schon H−1. */
  pointerHours: number;
  minutes: number;
  isRegional: boolean;
  specificity: number;
}

/** Löst die Tageshälfte auf (Tageszeitwort schlägt Heuristik, R2) und markiert eine
 * geratene Nachtzeit bzw. eine regionale Form als bestätigungspflichtig (R2 Regel 5, AK4).
 * Ein gefundenes Tageszeitwort wird in den Span aufgenommen — es verschwindet damit wie
 * Bindewörter aus dem Titel, ohne einen eigenen Entfernungsweg zu brauchen. */
function resolveHourMatch(text: string, raw: RawHourMatch, now: Date): Candidate<TimeValue> {
  if (raw.namedHour === null) {
    return {
      start: raw.start,
      end: raw.end,
      specificity: raw.specificity,
      value: { hours: raw.pointerHours, minutes: raw.minutes, needsConfirmation: false },
    };
  }
  const dayPart = findAdjacentDayPart(text, raw);
  const isPM = dayPart ? dayPart.isPM : now.getHours() * 60 + now.getMinutes() >= 12 * 60;
  // Zwölf ist der Fixpunkt des 12-Stunden-Zifferblatts, kein normaler 1-11-Wert: "zwölf
  // Uhr"/"um 12" bleibt immer Mittag (12:00), unabhängig von der Tageshälfte — genau das
  // vorbestehende Verhalten der einfachen Formen (#47/#618/#619). Nur "H−1"-Formen (halb/
  // viertel vor H) erreichen hier je 12 — die liegen für H=1..12 immer bei 0-11 und sind
  // von diesem Sonderfall nicht betroffen.
  const hours = raw.pointerHours === 12 ? 12 : (raw.pointerHours + (isPM ? 12 : 0)) % 24;
  const isGuessed = dayPart === null;
  const needsConfirmation = raw.isRegional || (isGuessed && hours < 6);
  return {
    start: dayPart ? Math.min(raw.start, dayPart.span.start) : raw.start,
    end: dayPart ? Math.max(raw.end, dayPart.span.end) : raw.end,
    specificity: raw.specificity,
    value: { hours, minutes: raw.minutes, needsConfirmation },
  };
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

// --- Zeigerzeit (R1, #688) -------------------------------------------------

const HALB_PATTERN = new RegExp(`${WORD_BEFORE}halb\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
const VIERTEL_NACH_PATTERN = new RegExp(`${WORD_BEFORE}viertel\\s+nach\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
const VIERTEL_VOR_PATTERN = new RegExp(`${WORD_BEFORE}viertel\\s+vor\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
// Regional (AK4): "viertel H"/"dreiviertel H" ohne "vor"/"nach" — verwechselbar mit
// "viertel nach H", deshalb immer bestätigungspflichtig (siehe `resolveHourMatch`).
const VIERTEL_BARE_PATTERN = new RegExp(`${WORD_BEFORE}viertel\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
const DREIVIERTEL_BARE_PATTERN = new RegExp(`${WORD_BEFORE}dreiviertel\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
const MINUTES_VOR_HALB_PATTERN = new RegExp(
  `${WORD_BEFORE}${MINUTE_TOKEN}\\s+vor\\s+halb\\s+${HOUR_TOKEN}${WORD_AFTER}`,
  'giu',
);
const MINUTES_NACH_HALB_PATTERN = new RegExp(
  `${WORD_BEFORE}${MINUTE_TOKEN}\\s+nach\\s+halb\\s+${HOUR_TOKEN}${WORD_AFTER}`,
  'giu',
);
const MINUTES_VOR_PATTERN = new RegExp(`${WORD_BEFORE}${MINUTE_TOKEN}\\s+vor\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');
const MINUTES_NACH_PATTERN = new RegExp(`${WORD_BEFORE}${MINUTE_TOKEN}\\s+nach\\s+${HOUR_TOKEN}${WORD_AFTER}`, 'giu');

// Länger als jede Form der einfachen Grammatik (max. Spezifität dort: 3) — bei
// Gleichstand in der Spanne (kommt praktisch nicht vor) gewinnt trotzdem die
// kompositionelle Form.
const ZEIGERZEIT_SPECIFICITY = 4;

function findZeigerzeitRawMatches(text: string): RawHourMatch[] {
  const raw: RawHourMatch[] = [];

  function push(match: RegExpMatchArray, pointerHours: number, minutes: number, namedHour: number, isRegional = false) {
    raw.push({
      start: match.index!,
      end: match.index! + match[0].length,
      namedHour,
      pointerHours,
      minutes,
      isRegional,
      specificity: ZEIGERZEIT_SPECIFICITY,
    });
  }

  for (const match of text.matchAll(HALB_PATTERN)) {
    const hour = resolveHourToken(match[1]);
    push(match, hour - 1, 30, hour);
  }
  for (const match of text.matchAll(VIERTEL_NACH_PATTERN)) {
    const hour = resolveHourToken(match[1]);
    push(match, hour, 15, hour);
  }
  for (const match of text.matchAll(VIERTEL_VOR_PATTERN)) {
    const hour = resolveHourToken(match[1]);
    push(match, hour - 1, 45, hour);
  }
  for (const match of text.matchAll(VIERTEL_BARE_PATTERN)) {
    const hour = resolveHourToken(match[1]);
    push(match, hour - 1, 15, hour, true);
  }
  for (const match of text.matchAll(DREIVIERTEL_BARE_PATTERN)) {
    const hour = resolveHourToken(match[1]);
    push(match, hour - 1, 45, hour, true);
  }
  for (const match of text.matchAll(MINUTES_VOR_HALB_PATTERN)) {
    const minute = resolveMinuteToken(match[1]);
    const hour = resolveHourToken(match[2]);
    push(match, hour - 1, 30 - minute, hour);
  }
  for (const match of text.matchAll(MINUTES_NACH_HALB_PATTERN)) {
    const minute = resolveMinuteToken(match[1]);
    const hour = resolveHourToken(match[2]);
    push(match, hour - 1, 30 + minute, hour);
  }
  for (const match of text.matchAll(MINUTES_VOR_PATTERN)) {
    const minute = resolveMinuteToken(match[1]);
    const hour = resolveHourToken(match[2]);
    push(match, hour - 1, 60 - minute, hour);
  }
  for (const match of text.matchAll(MINUTES_NACH_PATTERN)) {
    const minute = resolveMinuteToken(match[1]);
    const hour = resolveHourToken(match[2]);
    push(match, hour, minute, hour);
  }

  return raw;
}

function findTimeCandidate(text: string, now: Date): Candidate<TimeValue> | null {
  const raw: RawHourMatch[] = [];

  for (const { pattern, specificity } of DIGIT_TIME_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const hours = Number(match[1]);
      const minutes = match[2] ? Number(match[2]) : 0;
      // R2 Regel 3: eine Doppelpunkt-Uhrzeit ist immer ausgeschrieben (nie geraten,
      // egal welche Stunde), eine Stunde ab 13 bleibt so oder so unangetastet.
      const ambiguous = match[2] === undefined && hours <= 12;
      raw.push({
        start: match.index!,
        end: match.index! + match[0].length,
        namedHour: ambiguous ? hours : null,
        pointerHours: hours,
        minutes,
        isRegional: false,
        specificity,
      });
    }
  }

  for (const { pattern, specificity } of WORD_TIME_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const hours = WORD_NUMBERS[match[1].toLowerCase()];
      raw.push({
        start: match.index!,
        end: match.index! + match[0].length,
        namedHour: hours,
        pointerHours: hours,
        minutes: 0,
        isRegional: false,
        specificity,
      });
    }
  }

  raw.push(...findZeigerzeitRawMatches(text));

  const candidates = raw.map((match) => resolveHourMatch(text, match, now));
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
  needsConfirmation: boolean;
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
  const timeCandidate = findTimeCandidate(text, now);

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

  const needsConfirmation = timeCandidate?.value.needsConfirmation ?? false;

  const explicitTitle = findExplicitTitle(text);
  if (explicitTitle !== null) {
    return { date, hasExplicitTime, title: explicitTitle, needsConfirmation };
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
  return { date, hasExplicitTime, title, needsConfirmation };
}

export function parseTaskInput(text: string, now: Date = new Date()): ParsedTaskInput {
  const { date, title, needsConfirmation } = analyzeText(text, now);
  return { title, dueAt: date ? date.toISOString() : null, needsConfirmation };
}
