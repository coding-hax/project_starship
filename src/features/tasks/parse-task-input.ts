/**
 * Bewusst enge, deterministische Grammatik für deutsche Freiform-Eingaben (kein NLU,
 * keine Dependency) — issue #47 Schnitt 1, auf Spans umgebaut in #687 (Teil 1 von 3 des
 * Parser-Umbaus, Epic #617), um Zeigerzeit + Tageshälften erweitert in #688 (Teil 2 von 3),
 * um Monatsnamen/Spannen/"nächsten"/"gestern" + die Tagesgrenze 04:00 erweitert in #689
 * (Teil 3 von 3). Verfahren (angelehnt an chrono-node/Duckling):
 *
 * 1. Kandidaten mit Span `{ start, end }` erzeugen — nie `text.slice()` und auf dem Rest
 *    weiterarbeiten (das koppelte jedes weitere Ergebnis an die Zweig-Reihenfolge).
 * 2. Überlappen zwei Kandidaten desselben Typs (z. B. "um 14" und "um 14 Uhr"), gewinnt
 *    der längere Span — das ist der Fix für den "Uhr bleibt im Titel"-Bug.
 * 3. Titel = Rohtext minus aller Spans (Datum, Zeit, Kommandopräfix, angrenzende
 *    Bindewörter), danach Rand-Trim. Keine Wort-Blacklist mehr.
 *
 * Erkannt wird:
 * - Relative Tage: "gestern", "heute", "morgen", "übermorgen" — alle gegen den
 *   *logischen* Tag (R6, #689): zwischen 00:00 und 03:59 zählt noch der vorherige
 *   Kalendertag als "heute". Betrifft nur den Tag; die Tageshälfte (R2) und ob eine
 *   Uhrzeit schon vorbei ist, bleiben an der echten Uhr.
 * - Relative Spannen (#689): "in N Tagen"/"in einem Tag", "in N Wochen"/"in einer Woche".
 * - Wochentage: "montag".."sonntag" -> nächstes zukünftiges Vorkommen ab dem logischen
 *   Tag (fällt der Name auf den logischen Wochentag, zählt das als heute). Mit
 *   Modifikator (#689): "diesen"/"kommenden" sind Synonyme der bloßen Form, "nächsten"
 *   überspringt zusätzlich eine ganze Woche.
 * - Absolutes Datum: "am D.M.", "D.M." oder "D. Monatsname" (Jahr optional; ohne Jahr
 *   das nächste zukünftige Vorkommen ab dem logischen Tag). Ein kalendarisch ungültiges
 *   Datum (#689, z. B. "31.6.") wird verworfen, nie stumm auf den Folgemonat gerollt.
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
  /** #691: Grundtext für die Feld-Konfidenz „Datum"/„Uhrzeit", `null` wenn nicht geraten. */
  dateGuessReason: string | null;
  timeGuessReason: string | null;
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

// R6 (#689): zwischen 00:00 und 03:59 zählt noch der vorherige Kalendertag als "heute" —
// wer um 01:30 einen Termin "für morgen" anlegt, meint sonst den übernächsten Tag. Gilt
// nur für den Tag: die Tageshälfte (R2) und ob eine genannte Uhrzeit schon vorbei ist,
// bleiben an der echten Uhr (`now` unverändert), siehe `resolveHourMatch`/`resolveTimeOnlyDate`.
const DAY_BOUNDARY_HOUR = 4;

/** Start des *logischen* Tages (00:00) — der Bezugspunkt für alle relativen Tagesangaben
 * und den Log-Tag beim Abhaken (R6/R7, #689). Exportiert für `local-recognizer.ts`. */
export function logicalDayStart(now: Date): Date {
  const start = startOfDay(now);
  return now.getHours() < DAY_BOUNDARY_HOUR ? addDays(start, -1) : start;
}

// `\b` only recognizes ASCII word characters — it fails right at the leading "ü" of
// "übermorgen" (neither side of that position counts as \w), silently refusing to
// match the whole word. A Unicode-aware boundary via lookaround fixes that.
const WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
function wordPattern(pattern: string, flags = 'iu'): RegExp {
  return new RegExp(`${WORD_BEFORE}${pattern}${WORD_AFTER}`, flags);
}

// Ausgeschriebene Uhrzeiten 1-12 — Diktat sagt "um zwölf", nicht "um 12". Bewusst nur
// bis zwölf (AC8): 13-24 ausgeschrieben ist selten und bliebe sonst beim Default 09:00,
// was dokumentiert und akzeptiert ist (kein Scope-Creep, Regel 2). Auch die Basis für
// die Spannen-Zahlwörter in "in drei Tagen"/"in N Wochen" (#689) — dieselbe Tabelle.
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

function resolveHourToken(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : WORD_NUMBERS[token.toLowerCase()];
}

// --- Datum -------------------------------------------------------------

const RELATIVE_DAYS: Record<string, number> = { gestern: -1, heute: 0, morgen: 1, übermorgen: 2 };
// Date.getDay() order: 0 = Sonntag.
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
// "nächsten" überspringt zusätzlich eine Woche; "diesen"/"kommenden" sind reine
// Synonyme der bloßen Wochentagsform (AK3, #689) — echte Bedeutungsunterscheidung,
// kein beliebig austauschbares Vokabular.
const WEEKDAY_MODIFIERS = ['nächsten', 'diesen', 'kommenden'];

/** Kürzel im Telegrammstil — Index wie in WEEKDAYS (Sonntag = 0). */
const WEEKDAY_ABBREVIATIONS: [string, number][] = [
  ['so', 0], ['mo', 1], ['di', 2], ['mi', 3], ['do', 4], ['fr', 5], ['sa', 6],
];
/** Ein Kürzel ohne Punkt zählt nur, wenn direkt eine Zeitangabe folgt. */
const ABBREVIATION_TIME_FOLLOWS = String.raw`(?=\s+(?:\d|um\s|früh|morgens|vormittags|mittags|nachmittags|abends|nachts|halb|viertel))`;

// Kein `\b` am Ende: bei "4.8." (Standard-Schreibweise mit Punkt nach dem Monat, kein
// Jahr) liegt der zweite Punkt direkt vor Zeilenende — zwei Nicht-Wortzeichen bilden
// dort nie eine Wortgrenze, ein abschließendes `\b` würde diesen Fall nie treffen.
const ABSOLUTE_DATE_PATTERN = /\b(?:am\s+)?(\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?/giu;

const MONTH_NAMES = [
  'januar',
  'februar',
  'märz',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'dezember',
];
const MONTH_NAME_DATE_PATTERN = new RegExp(
  String.raw`\b(?:am\s+)?(\d{1,2})\.\s*(${MONTH_NAMES.join('|')})(?:\s+(\d{4}))?\b`,
  'giu',
);

// AK1 (#689): "31.6." existiert nicht und darf nicht stumm auf den 1. Juli rollen — ein
// kalendarisch ungültiger Kandidat wird verworfen (kein Push), statt geraten zu werden.
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

// Relative Spannen (AK2, #689): "in drei Tagen"/"in einem Tag", "in einer Woche"/
// "in N Wochen" — Diktat sagt dative Einzahl ("einem Tag"/"einer Woche"), nicht die
// Grundform, deshalb eigene Sonderwörter statt WORD_NUMBERS' "eins/ein" zu missbrauchen.
const DAY_SPAN_TOKEN = `(einem|\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;
const DAY_SPAN_PATTERN = new RegExp(`${WORD_BEFORE}in\\s+${DAY_SPAN_TOKEN}\\s+(?:tage?n?)${WORD_AFTER}`, 'giu');
const WEEK_SPAN_TOKEN = `(einer|\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;
const WEEK_SPAN_PATTERN = new RegExp(`${WORD_BEFORE}in\\s+${WEEK_SPAN_TOKEN}\\s+wochen?${WORD_AFTER}`, 'giu');

function resolveSpanToken(token: string, singularWord: string): number {
  return token.toLowerCase() === singularWord ? 1 : resolveHourToken(token);
}

interface DateValue {
  date: Date;
  /** #691: Grundtext für die Feld-Konfidenz „Datum" im Bestätigen-Dialog, `null` wenn
   * das Datum nicht geraten ist (siehe „Was als guessed gilt" in issue #691). */
  guessReason: string | null;
}

const WEEKDAY_ONLY_REASON = 'Wochentag ohne Datum';
const WEEKDAY_NEXT_REASON = '„nächsten" überspringt eine Woche';
const YEAR_COMPLETED_REASON = 'Jahr ergänzt';

/**
 * Datumsspanne mit gemeinsamem Monat: „vom 3. bis 10. März", „vom 3.-5. Mai".
 * Gemeint ist der Anfang; der Span deckt den ganzen Ausdruck ab, sonst bliebe
 * „Urlaub vom 3" stehen.
 */
const DATE_RANGE_SPECIFICITY = 6;
const DATE_RANGE_PATTERN = new RegExp(
  String.raw`\bvo[nm]\s+(\d{1,2})\.?\s*(?:bis|-|–)\s*(?:zum\s+)?(\d{1,2})\.?\s*(` +
    MONTH_NAMES.join('|') +
    String.raw`)`,
  'giu',
);

/** Der letzte Tag der Datumsspanne — ganztägig, deshalb ohne Uhrzeit. */
function findDateRangeEnd(text: string, now: Date): Date | null {
  for (const match of text.matchAll(DATE_RANGE_PATTERN)) {
    const day = Number(match[2]);
    const month = MONTH_NAMES.indexOf(match[3].toLowerCase()) + 1;
    if (!isValidCalendarDate(now.getFullYear(), month, day)) continue;
    const end = new Date(now.getFullYear(), month - 1, day);
    if (end < logicalDayStart(now)) end.setFullYear(end.getFullYear() + 1);
    end.setHours(9, 0, 0, 0);
    return end;
  }
  return null;
}

function findDateCandidate(text: string, now: Date): Candidate<DateValue> | null {
  const candidates: Candidate<DateValue>[] = [];
  const logicalStart = logicalDayStart(now);

  for (const match of text.matchAll(DATE_RANGE_PATTERN)) {
    const day = Number(match[1]);
    const month = MONTH_NAMES.indexOf(match[3].toLowerCase()) + 1;
    if (!isValidCalendarDate(now.getFullYear(), month, day)) continue;
    const date = new Date(now.getFullYear(), month - 1, day);
    if (date < logicalStart) date.setFullYear(date.getFullYear() + 1);
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date, guessReason: null },
      specificity: DATE_RANGE_SPECIFICITY,
    });
  }

  for (const match of text.matchAll(ABSOLUTE_DATE_PATTERN)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3] ? Number(match[3]) : now.getFullYear();
    if (!isValidCalendarDate(year, month, day)) continue;
    const date = new Date(year, month - 1, day);
    let yearCompleted = false;
    if (!match[3] && date < logicalStart) {
      date.setFullYear(date.getFullYear() + 1);
      yearCompleted = true;
    }
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date, guessReason: yearCompleted ? YEAR_COMPLETED_REASON : null },
      specificity: 3,
    });
  }

  for (const match of text.matchAll(MONTH_NAME_DATE_PATTERN)) {
    const day = Number(match[1]);
    const month = MONTH_NAMES.indexOf(match[2].toLowerCase()) + 1;
    const year = match[3] ? Number(match[3]) : now.getFullYear();
    if (!isValidCalendarDate(year, month, day)) continue;
    const date = new Date(year, month - 1, day);
    let yearCompleted = false;
    if (!match[3] && date < logicalStart) {
      date.setFullYear(date.getFullYear() + 1);
      yearCompleted = true;
    }
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date, guessReason: yearCompleted ? YEAR_COMPLETED_REASON : null },
      specificity: 3,
    });
  }

  const relativePattern = wordPattern(`(${Object.keys(RELATIVE_DAYS).join('|')})`, 'giu');
  for (const match of text.matchAll(relativePattern)) {
    const key = match[1].toLowerCase();
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date: addDays(logicalStart, RELATIVE_DAYS[key]), guessReason: null },
      specificity: 2,
    });
  }

  for (const match of text.matchAll(DAY_SPAN_PATTERN)) {
    const days = resolveSpanToken(match[1], 'einem');
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date: addDays(logicalStart, days), guessReason: null },
      specificity: 3,
    });
  }

  for (const match of text.matchAll(WEEK_SPAN_PATTERN)) {
    const weeks = resolveSpanToken(match[1], 'einer');
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: { date: addDays(logicalStart, weeks * 7), guessReason: null },
      specificity: 3,
    });
  }

  // R3/AK1 (#691): jeder Wochentags-Treffer ist geraten — "diesen"/"kommenden" sind
  // reine Synonyme der bloßen Form (dieselbe Ambiguität), nur "nächsten" bekommt einen
  // eigenen Grundtext, weil der Wochensprung der überraschendere Fall ist.
  const weekdayPattern = wordPattern(
    `(?:(${WEEKDAY_MODIFIERS.join('|')})\\s+)?(${WEEKDAYS.join('|')})`,
    'giu',
  );
  for (const match of text.matchAll(weekdayPattern)) {
    const modifier = match[1]?.toLowerCase() ?? null;
    const targetDay = WEEKDAYS.indexOf(match[2].toLowerCase());
    let diff = (targetDay - logicalStart.getDay() + 7) % 7;
    if (modifier === 'nächsten') diff += 7;
    candidates.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: {
        date: addDays(logicalStart, diff),
        guessReason: modifier === 'nächsten' ? WEEKDAY_NEXT_REASON : WEEKDAY_ONLY_REASON,
      },
      specificity: modifier ? 2 : 1,
    });
  }

  // Telegrammstil: „Mo 14 Uhr Zahnarzt", „Di früh Sport". Die Kürzel sind zu kurz, um
  // sie frei laufen zu lassen — „so", „mi" und „do" sind auch gewöhnliche Wörter.
  // Deshalb nur mit Punkt („Mo.") oder wenn unmittelbar eine Zeitangabe folgt.
  for (const [abbreviation, targetDay] of WEEKDAY_ABBREVIATIONS) {
    const pattern = new RegExp(
      `${WORD_BEFORE}${abbreviation}(?:\\.|${ABBREVIATION_TIME_FOLLOWS})`,
      'giu',
    );
    for (const match of text.matchAll(pattern)) {
      const diff = (targetDay - logicalStart.getDay() + 7) % 7;
      candidates.push({
        start: match.index!,
        end: match.index! + match[0].length,
        value: { date: addDays(logicalStart, diff), guessReason: WEEKDAY_ONLY_REASON },
        specificity: 1,
      });
    }
  }

  return bestCandidate(candidates);
}

// --- Wiederholung ----------------------------------------------------------

/**
 * Wiederholungsausdrücke: „jeden Montag", „alle zwei Wochen", „täglich", „werktags".
 *
 * Die Form entspricht bewusst `events.recurrence` aus dem Schema (freq/interval/
 * byWeekday) — die Spalte ist für S6/S7 reserviert. Der Erfasser **erkennt** hier nur;
 * geschrieben wird der Wert nicht, solange es keine Expansion gibt. Ein Wert in der
 * Spalte ohne Expansion verspräche eine Wiederholung, die nie einträte.
 *
 * Der Span deckt den ganzen Ausdruck ab: ohne ihn blieb „Jeden Montag Müll rausbringen"
 * als Titel „Jeden Müll rausbringen" zurück.
 */
export interface RecurrenceValue {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  /** Wochentage als `Date#getDay()`-Index, nur bei `weekly`. */
  byWeekday?: number[];
}

const WEEKDAY_ADVERBS = WEEKDAYS.map((day) => `${day}s`);
const COUNT_TOKEN = `(\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;

function countOf(token: string | undefined): number {
  if (!token) return 1;
  const digits = Number(token);
  if (!Number.isNaN(digits)) return digits;
  return WORD_NUMBERS[token.toLowerCase()] ?? 1;
}

const RECURRENCE_RULES: { pattern: RegExp; build: (m: RegExpMatchArray) => RecurrenceValue }[] = [
  // „jeden Montag", „jeden zweiten Montag"
  {
    // Ordinalendung mitnehmen: „jeden zweiten Montag" — `zwei` + `ten`.
    pattern: wordPattern(
      `(?:jeden|jede|jedes|immer)\\s+(?:${COUNT_TOKEN}(?:te[nrms]?|n)?\\s+)?(${WEEKDAYS.join('|')})`,
      'giu',
    ),
    build: (m) => ({ freq: 'weekly', interval: countOf(m[1]), byWeekday: [WEEKDAYS.indexOf(m[2].toLowerCase())] }),
  },
  // „immer freitags", „freitags"
  {
    pattern: wordPattern(`(?:immer\\s+)?(${WEEKDAY_ADVERBS.join('|')})`, 'giu'),
    build: (m) => ({ freq: 'weekly', interval: 1, byWeekday: [WEEKDAY_ADVERBS.indexOf(m[1].toLowerCase())] }),
  },
  {
    pattern: wordPattern('(?:werktags|jeden\\s+werktag|unter\\s+der\\s+woche)', 'giu'),
    build: () => ({ freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] }),
  },
  {
    pattern: wordPattern('(?:täglich|jeden\\s+tag|jeden\\s+einzelnen\\s+tag)', 'giu'),
    build: () => ({ freq: 'daily', interval: 1 }),
  },
  {
    pattern: wordPattern(`(?:alle|jede)\\s+${COUNT_TOKEN}\\s+tage?n?`, 'giu'),
    build: (m) => ({ freq: 'daily', interval: countOf(m[1]) }),
  },
  {
    pattern: wordPattern(`(?:alle|jede)\\s+${COUNT_TOKEN}\\s+wochen?`, 'giu'),
    build: (m) => ({ freq: 'weekly', interval: countOf(m[1]) }),
  },
  {
    pattern: wordPattern('(?:wöchentlich|jede\\s+woche)', 'giu'),
    build: () => ({ freq: 'weekly', interval: 1 }),
  },
  {
    pattern: wordPattern(`(?:alle|jede[ns]?)\\s+${COUNT_TOKEN}\\s+monate?n?`, 'giu'),
    build: (m) => ({ freq: 'monthly', interval: countOf(m[1]) }),
  },
  {
    pattern: wordPattern('(?:monatlich|jeden\\s+monat)', 'giu'),
    build: () => ({ freq: 'monthly', interval: 1 }),
  },
  {
    pattern: wordPattern('(?:jährlich|jedes\\s+jahr)', 'giu'),
    build: () => ({ freq: 'yearly', interval: 1 }),
  },
];

interface RecurrenceMatch extends Span {
  value: RecurrenceValue;
}

/** Längster Treffer gewinnt: „jeden zweiten Montag" schlägt „montag". */
function findRecurrence(text: string): RecurrenceMatch | null {
  let best: RecurrenceMatch | null = null;
  for (const { pattern, build } of RECURRENCE_RULES) {
    for (const match of text.matchAll(pattern)) {
      const candidate: RecurrenceMatch = {
        start: match.index!,
        end: match.index! + match[0].length,
        value: build(match),
      };
      if (!best || candidate.end - candidate.start > best.end - best.start) best = candidate;
    }
  }
  return best;
}

// --- Uhrzeit -------------------------------------------------------------

const WORD_NUMBER_GROUP = `(${Object.keys(WORD_NUMBERS).join('|')})`;

interface TimeValue {
  hours: number;
  minutes: number;
  /** R2 Regel 5 + AK4: eine in den Nachtfenster (00:00-05:59) geratene Tageshälfte oder
   * eine regionale Kurzform — der Aufgaben-Pfad zeigt dann das Bestätigungs-Sheet, auch
   * wenn "ohne Bestätigung direkt anlegen" an ist. */
  needsConfirmation: boolean;
  /** #691: Grundtext für die Feld-Konfidenz „Uhrzeit" im Bestätigen-Dialog — anders als
   * `needsConfirmation` unabhängig vom Nachtfenster, jede geratene Tageshälfte zählt. */
  guessReason: string | null;
}

const DAY_PART_GUESSED_REASON = 'Tageshälfte geraten';
const REGIONAL_TIME_REASON = 'regionale Zeitangabe';
const NO_TIME_GIVEN_REASON = 'keine Uhrzeit gesagt';

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
/**
 * Mahlzeiten verraten die Tageshälfte, gehören aber zum Titel: „um halb acht Abendessen
 * bei Müllers" ist 19:30, und der Titel bleibt „Abendessen bei Müllers". Deshalb nur der
 * Wahrheitswert, kein Span — anders als bei den Tageszeitwörtern unten.
 */
const MEAL_HINTS: Record<string, boolean> = {
  frühstück: false,
  frühstücken: false,
  brunch: false,
  mittagessen: true,
  mittagspause: true,
  abendessen: true,
  abendbrot: true,
};
const MEAL_HINT_PATTERN = wordPattern(`(${Object.keys(MEAL_HINTS).join('|')})`, 'giu');

function findMealHint(text: string): boolean | null {
  for (const match of text.matchAll(MEAL_HINT_PATTERN)) {
    return MEAL_HINTS[match[1].toLowerCase()];
  }
  return null;
}

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
      value: { hours: raw.pointerHours, minutes: raw.minutes, needsConfirmation: false, guessReason: null },
    };
  }
  const dayPart = findAdjacentDayPart(text, raw);
  const mealHint = dayPart === null ? findMealHint(text) : null;
  const isPM =
    dayPart !== null
      ? dayPart.isPM
      : mealHint !== null
        ? mealHint
        : now.getHours() * 60 + now.getMinutes() >= 12 * 60;
  // Zwölf ist der Fixpunkt des 12-Stunden-Zifferblatts, kein normaler 1-11-Wert: "zwölf
  // Uhr"/"um 12" bleibt immer Mittag (12:00), unabhängig von der Tageshälfte — genau das
  // vorbestehende Verhalten der einfachen Formen (#47/#618/#619). Nur "H−1"-Formen (halb/
  // viertel vor H) erreichen hier je 12 — die liegen für H=1..12 immer bei 0-11 und sind
  // von diesem Sonderfall nicht betroffen.
  const isFixedNoon = raw.pointerHours === 12;
  const hours = isFixedNoon ? 12 : (raw.pointerHours + (isPM ? 12 : 0)) % 24;
  // Der Fixpunkt braucht keine Tageshälfte, um 12:00 aufzulösen (s. o.) — für die
  // Feld-Konfidenz ist da folglich auch nichts geraten, unabhängig von `dayPart`.
  const isGuessed = !isFixedNoon && dayPart === null && mealHint === null;
  const needsConfirmation = raw.isRegional || (isGuessed && hours < 6);
  // #691: die Feld-Konfidenz ist strenger als `needsConfirmation` — jede aus dem
  // Sprechzeitpunkt abgeleitete Tageshälfte gilt als geraten, nicht nur eine, die ins
  // Nachtfenster fällt. Regional schlägt (Verwechslungsgefahr unabhängig von der Uhrzeit).
  const guessReason = raw.isRegional ? REGIONAL_TIME_REASON : isGuessed ? DAY_PART_GUESSED_REASON : null;
  return {
    start: dayPart ? Math.min(raw.start, dayPart.span.start) : raw.start,
    end: dayPart ? Math.max(raw.end, dayPart.span.end) : raw.end,
    specificity: raw.specificity,
    value: { hours, minutes: raw.minutes, needsConfirmation, guessReason },
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
  // Telegrammstil „19h", „8h" — im Erfassungsfeld meint das die Uhrzeit.
  // Nur gültige Stunden: „24h Service" ist eine Öffnungszeit, keine Uhrzeit.
  { pattern: /\b((?:[01]?\d|2[0-3]))()h\b/giu, specificity: 2 },
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

/**
 * Tageszeitwort ohne Uhrzeit (Entscheidung 03.09.26): „heute Abend" meint 19 Uhr, nicht
 * den Standardtermin 09:00. Niedrigste Spezifität — jede ausgesprochene Uhrzeit im Satz
 * schlägt diese Lesart, das Wort geht dann ohnehin über `findAdjacentDayPart` in deren
 * Span ein und verschwindet mit ihm aus dem Titel.
 */
const STANDALONE_DAY_PARTS: [string, number][] = [
  ['am morgen', 8], ['am vormittag', 10], ['am mittag', 12], ['zu mittag', 12],
  ['am nachmittag', 15], ['am abend', 19], ['in der nacht', 22],
  ['morgens', 8], ['früh', 8], ['vormittags', 10], ['mittags', 12],
  ['nachmittags', 15], ['abends', 19], ['abend', 19], ['nachts', 22],
  // Substantivform ohne Präposition: „Morgen Nachmittag Oma anrufen". „morgen" steht
  // hier bewusst NICHT — das ist der Kalendertag, nicht die Tageszeit.
  ['vormittag', 10], ['mittag', 12], ['nachmittag', 15], ['nacht', 22],
];

function findStandaloneDayPartCandidates(text: string): Candidate<TimeValue>[] {
  const candidates: Candidate<TimeValue>[] = [];
  for (const [phrase, hours] of STANDALONE_DAY_PARTS) {
    for (const match of text.matchAll(wordPattern(phrase, 'giu'))) {
      candidates.push({
        start: match.index!,
        end: match.index! + match[0].length,
        value: { hours, minutes: 0, needsConfirmation: false, guessReason: null },
        // Mehrwortformen („am abend") schlagen die Kurzform, damit das „am" mit aus
        // dem Titel fällt; beide bleiben unter jeder echten Uhrzeit.
        specificity: phrase.includes(' ') ? 1 : 0,
      });
    }
  }
  return candidates;
}

/**
 * Zeitspannen (#erfasser-korpus): „von 10 bis 12", „zwischen 14 und 16 Uhr", „9-17 Uhr".
 *
 * Ein Termin, zwei genannte Uhrzeiten — gemeint ist der **Anfang**. Ohne diese Muster
 * gewann die zweite Zahl (das Ende) und die erste blieb als Bruchstück im Titel stehen
 * („Termin zwischen 14 und"). Der Span deckt den ganzen Ausdruck ab, damit nichts
 * zurückbleibt; die Spezifität liegt über allen Einzelformen.
 */
const TIME_RANGE_SPECIFICITY = 6;
const TIME_RANGE_PATTERNS: RegExp[] = [
  /\bzwischen\s+(\d{1,2})(?::(\d{2}))?\s+und\s+(\d{1,2})(?::(\d{2}))?(?:\s*uhr)?/giu,
  /\bvon\s+(\d{1,2})(?::(\d{2}))?\s*(?:uhr\s*)?(?:bis|-|–)\s*(\d{1,2})(?::(\d{2}))?(?:\s*uhr)?/giu,
  /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–)\s*(\d{1,2})(?::(\d{2}))?\s*uhr\b/giu,
  /\b(\d{1,2})(?::(\d{2}))?\s+bis\s+(\d{1,2})(?::(\d{2}))?\s*uhr\b/giu,
];

/**
 * Das Ende der Zeitspanne. Der Start läuft über `findTimeRangeMatches` durch die
 * normale Tageshälften-Auflösung; das Ende richtet sich danach: liegt es davor, war
 * dieselbe Tageshälfte gemeint („von 2 bis 4 nachmittags" ist 14–16 Uhr).
 */
function findTimeRangeEnd(text: string, startHours: number): { hours: number; minutes: number } | null {
  for (const pattern of TIME_RANGE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      let hours = Number(match[3]);
      const minutes = match[4] ? Number(match[4]) : 0;
      if (Number.isNaN(hours) || hours > 23 || minutes > 59) continue;
      if (hours < startHours && hours + 12 <= 23) hours += 12;
      return { hours, minutes };
    }
  }
  return null;
}

function findTimeRangeMatches(text: string): RawHourMatch[] {
  const found: RawHourMatch[] = [];
  for (const pattern of TIME_RANGE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const hours = Number(match[1]);
      const minutes = match[2] ? Number(match[2]) : 0;
      if (hours > 23 || minutes > 59) continue;
      found.push({
        start: match.index!,
        end: match.index! + match[0].length,
        // Wie sonst auch: eine Stunde bis 12 ohne Minutenangabe bleibt mehrdeutig und
        // geht durch die Tageshälften-Auflösung.
        namedHour: match[2] === undefined && hours <= 12 ? hours : null,
        pointerHours: hours,
        minutes,
        isRegional: false,
        specificity: TIME_RANGE_SPECIFICITY,
      });
    }
  }
  return found;
}

function findTimeCandidate(text: string, now: Date): Candidate<TimeValue> | null {
  const raw: RawHourMatch[] = [...findTimeRangeMatches(text)];

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
  candidates.push(...findStandaloneDayPartCandidates(text));
  return bestCandidate(candidates);
}

// --- Kommandopräfixe & Bindewörter (R3) -----------------------------------

const COMMAND_PREFIXES: RegExp[] = [
  /^erstelle\b(\s+(einen|eine)\b)?(\s+aufgabe\b)?\s*:?\s*/iu,
  // „daran" gehört zum Rahmen, nicht zum Titel — ohne das blieb „Erinnere mich daran den
  // Müll rauszubringen" als „daran den Müll rauszubringen" stehen.
  /^erinnere?\s+mich\b(\s+(an|daran)\b)?\s*:?\s*/iu,
  /^neue\s+aufgabe\b\s*:?\s*/iu,
  /^aufgabe\b\s*:\s*/iu,
  /^bitte\b\s+/iu,
  /^trag\b(\s+ein\b)?\s*:?\s*/iu,
  // AK4 (#689): der Satz aus #620, die Begründung für den Modell-Parser — muss lokal fallen.
  // Das Verb dahinter nur aus einer geschlossenen Liste: ein freies `\w+` fräße bei
  // „kannst du mir Milch kaufen eintragen" das erste Titelwort.
  /^(?:kannst|könntest|würdest|magst)\s+du\b(?:\s+(?:mir|uns|das|es))?(?:\s+bitte)?(?:\s+(?:eintragen|notieren|aufschreiben|merken|anlegen|erstellen|hinzufügen|vermerken))?(?:\s+bitte)?\s*:?\s*/iu,
  // Sprechrahmen aus dem Goldkorpus: reine Absichtserklärungen ohne Titelbeitrag.
  /^nicht\s+vergessen\b\s*:?\s*/iu,
  /^denk(e)?\s+(dran|daran)\b\s*:?\s*/iu,
  /^todo\b\s*:?\s*/iu,
  /^merken\b\s*:\s*/iu,
  /^ich\s+(?:muss|müsste|sollte|will|wollte|möchte|mag)\b(?:\s+(?:noch|mal|wieder|unbedingt))*\s*/iu,
  /^ich\s+darf\s+nicht\s+vergessen\b\s*:?\s*/iu,
  /^ich\s+(?:brauch|brauche|hab|habe)\b\s*/iu,
  /^ich\s+(?:geh|gehe|fahr|fahre|komm|komme)\b\s*/iu,
  /^(?:wär|wäre)\s+(?:super|gut|toll|nett|klasse)\s+wenn\s+du\b\s*/iu,
  /^ich\s+(?:hab|habe)\b(?:\s+noch)?\s+vor\b\s*:?\s*/iu,
  /^unbedingt\b\s+/iu,
  /^am\s+besten\b\s*/iu,
  /^wichtig\b\s*:\s*/iu,
  // Zögern und Gesprächspartikeln. Die Schleife in `findCommandPrefixSpans` frisst
  // aneinandergereihte Präfixe, „Ach ja," fällt deshalb als „ach" + „ja".
  // Strengere Grenze als `\b`: sonst frisst „ja" den Kopf von „Ja-Sager Buch zurückgeben"
  // und „ok" den von „Ok-Zeichen entwerfen" — `\b` steht auch vor einem Bindestrich.
  /^(?:also|äh+m?|naja|na\s+ja|okay|ok|hm+|ach|übrigens|tja|ja)(?![\p{L}\p{N}_-])\s*,?\s*/iu,
  /^ich\s+hätte\s+(?:gern|gerne)\b\s*/iu,
  // „Neuer Termin Mittwoch 16 Uhr Teamrunde" — hier ist das Objektwort Rahmen, nicht Titel.
  /^neue(?:r|s)?\s+(?:termin|aufgabe|notiz|eintrag|erinnerung)\b\s*:?\s*/iu,
  // Nebensatz-Einleitung nach „schreib auf, …" / „mach eine Notiz, …".
  /^dass\s+ich\b\s*/iu,
  // Zirkumfix „erinnere mich … an": das „an" kann hinter einem Einschub stehen
  // („erinnere mich bitte morgen früh an die Rechnung").
  /^erinnere?\s+mich\b(?:\s+bitte)?(?:\s+\S+){0,3}?\s+(?:an|daran)\b\s*/iu,
];

// "einen"/"eine" dazu (AK4, #689): dieselbe Span-Grenzen-Regel wie die übrigen
// Bindewörter, keine Sonderbehandlung nötig.
const CONNECTOR_WORDS = ['am', 'um', 'für', 'daran', 'beim', 'einen', 'eine'];

// Trailing Diktat-Verb (AK4, #689): "... einstellen" am Satzende — das Pendant zu den
// Kommandopräfixen, nur am Ende statt am Anfang.
const COMMAND_SUFFIX_PATTERN =
  /\s+(?:einstellen|eintragen|anlegen|hinzufügen|notieren|notierst|vermerken|nicht\s+vergessen|muss|will|soll|möchte)\s*[!.]*\s*(?=[,;:]|$)/iu;

function findCommandSuffixSpan(text: string): Span | null {
  const match = text.match(COMMAND_SUFFIX_PATTERN);
  if (!match) return null;
  return { start: match.index!, end: match.index! + match[0].length };
}

/** Kommandopräfixe können sich am Satzanfang aneinanderreihen ("erstelle" + "neue aufgabe"). */
function findCommandPrefixSpans(text: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (;;) {
    const remaining = text.slice(cursor);
    const match = COMMAND_PREFIXES.map((pattern) => remaining.match(pattern))
      .filter((candidate): candidate is RegExpMatchArray => candidate !== null && candidate[0].length > 0)
      // Längstes Match gewinnt: „erinnere mich bitte morgen früh an" schlägt „erinnere mich".
      .sort((a, b) => b[0].length - a[0].length)[0];
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

/**
 * Bindewörter, die nur **links** vom Datum fallen dürfen: „bis Freitag", „ab Montag".
 * Getrennt von CONNECTOR_WORDS, weil dieselben Wörter rechts vom Anker etwas anderes
 * sind — das „ab" aus „hake Sport für heute ab" ist ein trennbares Verb und gehört
 * nicht aus dem Titel geschnitten.
 */
const LEADING_CONNECTOR_WORDS = [
  'bis', 'spätestens', 'ab', 'gegen',
  // Wiederholungswörter: „Jeden Montag Müll rausbringen" ergab sonst den Titel
  // „Jeden Müll rausbringen". Eine echte Wiederholung kann der Erfasser noch nicht
  // anlegen (recurrenceRule ist im Schema reserviert) — der Titel muss trotzdem stimmen.
  'jeden', 'jede', 'jedes', 'alle', 'immer',
];

function findConnectorSpans(text: string, anchors: Span[]): Span[] {
  if (anchors.length === 0) return [];
  const candidates: [string, boolean][] = [
    ...CONNECTOR_WORDS.map((word): [string, boolean] => [word, false]),
    ...LEADING_CONNECTOR_WORDS.map((word): [string, boolean] => [word, true]),
  ];
  const spans: Span[] = [];
  // Ketten wie „bis spätestens Freitag" fallen nur ganz, wenn ein gerade entferntes
  // Bindewort selbst zum Anker fürs nächste wird — deshalb bis zum Fixpunkt.
  for (;;) {
    const known = [...anchors, ...spans];
    const before = spans.length;
    for (const [word, leadingOnly] of candidates) {
      const pattern = wordPattern(word, 'giu');
      for (const match of text.matchAll(pattern)) {
        const candidate: Span = { start: match.index!, end: match.index! + match[0].length };
        if (known.some((span) => overlaps(span, candidate))) continue;
        const adjacent = known.filter((span) => isAdjacent(candidate, span, text));
        if (adjacent.length === 0) continue;
        if (leadingOnly && !adjacent.some((span) => candidate.end <= span.start)) continue;
        spans.push(candidate);
      }
    }
    if (spans.length === before) break;
  }
  return spans;
}

// --- Diktierte Kommandos ---------------------------------------------------

/**
 * Gesprochene Kommandos reihen Verb, Dativpronomen, Höflichkeitsfloskel, Artikel und
 * Objektwort frei aneinander: „erstell mir einen Termin für Mittwoch", „leg mir eine
 * Aufgabe an, Milch kaufen", „trag mir bitte für morgen einen Termin mit Anna ein".
 * Die feste Präfixliste oben deckt das nicht ab — sie kennt nur ganze Wendungen.
 *
 * Das Objektwort selbst bleibt im Titel stehen („einen Termin mit Anna" → „Termin mit
 * Anna"), sonst bliebe von „erstell mir einen Termin für Mittwoch" gar nichts übrig.
 * Kündigt aber ein Trenner den eigentlichen Titel an („eine Aufgabe an, Milch kaufen"),
 * fällt der ganze Kopf und der Titel ist, was dahinter steht.
 */
const DICTATION_VERB =
  String.raw`(?:erstell|mach|leg|setz|trag|füg|notier|schreib|pack|speicher|plan|richt|merk|vermerk|gib|hol|tu|nimm)(?:e|st)?`;
/** „das mal", „mir bitte kurz" — was zwischen Verb und Objekt an Füllung stehen darf. */
const DICTATION_FILLER = String.raw`(?:\s+(?:mir|dir|uns|mich|das|es))?(?:\s+(?:bitte|mal|kurz|eben|schnell|noch))*`;
const DICTATION_OBJECT =
  String.raw`(?:termine?|aufgaben?|notiz|eintrag|erinnerung|todo|liste|merkzettel)`;

const DICTATION_HEAD_PATTERN = new RegExp(
  String.raw`^\s*${DICTATION_VERB}\b${DICTATION_FILLER}\s*`,
  'iu',
);
/** Kopf bis zum Trenner — dazwischen höchstens vier Wörter, damit kein Titel mitgeht. */
const DICTATION_BODY_PATTERN = new RegExp(
  String.raw`^\s*${DICTATION_VERB}\b${DICTATION_FILLER}` +
    // Entweder ein Objektwort („… eine Aufgabe an, X") oder bloss ein Verbpartikel
    // („schreib auf, X") — beides kündigt denselben Trenner an.
    String.raw`(?:(?:\s+\S+){0,4}?\s+(?:einen|eine|ein|nen|den|die|das)?\s*${DICTATION_OBJECT}\b(?:\s+\S+){0,4}?)?` +
    String.raw`(?:\s+(?:an|ein|hinzu|auf|dazu))?\s*[,:]\s*` +
    // „…, dass ich X" — die Nebensatz-Einleitung gehört zum Rahmen.
    String.raw`(?:dass\s+(?:ich|wir)\s+)?`,
  'iu',
);
/**
 * Ein Kommandoverb allein macht noch kein Diktat: „Plan B besprechen", „Setz Kaffee auf"
 * und „Pack Koffer" sind Aufgaben, deren erstes Wort zufällig auch ein Diktierverb ist.
 * Der Kopf fällt deshalb nur, wenn ein zweites Signal danebensteht — ein Dativpronomen,
 * eine Höflichkeitsfloskel oder ein Objektwort. (Der Trenner-Fall läuft über
 * DICTATION_BODY_PATTERN und braucht diese Prüfung nicht.)
 */
const DICTATION_MARKER_PATTERN = new RegExp(
  String.raw`^\s*${DICTATION_VERB}\b(?:` +
    String.raw`\s+(?:mir|dir|uns)(?![\p{L}\p{N}_])` +
    String.raw`|\s+(?:mich|das|es)(?![\p{L}\p{N}_])` +
    String.raw`|\s+(?:bitte|mal|kurz|eben)(?![\p{L}\p{N}_])` +
    String.raw`|(?:\s+\S+){0,4}?\s+(?:einen|eine|ein|nen|ne|den|die|das)?\s*${DICTATION_OBJECT}(?![\p{L}\p{N}_])` +
    String.raw`)`,
  'iu',
);

const DICTATION_DATIVE_PATTERN = /(?<![\p{L}\p{N}_])(?:mir|dir|uns)(?![\p{L}\p{N}_])/giu;
const DICTATION_POLITE_PATTERN = /(?<![\p{L}\p{N}_])bitte(?![\p{L}\p{N}_])/giu;
/** Nur der Artikel VOR dem Objektwort — das Objektwort trägt den Titel. */
const DICTATION_ARTICLE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:einen|eine|ein|nen|ne)\s+(?=${DICTATION_OBJECT}(?![\p{L}\p{N}_]))`,
  'giu',
);
/** Trennbares Verbpartikel am Ende: „… einen Termin mit Anna ein". */
const DICTATION_PARTICLE_PATTERN = /\s+(?:an|ein|hinzu|auf|dazu|rein|fest)\s*(?=[,;:]|$)/iu;
/** „setz das auf die Liste", „pack auf meine Liste" — Ablage-Ort, kein Titelbestandteil. */
const DICTATION_LIST_PATTERN =
  /\s*\bauf\s+(?:die|meine|unsere|'?ne)\s+(?:liste|todo-?liste|merkliste|einkaufsliste)\b/giu;

function findDictationSpans(text: string): Span[] {
  const head = text.match(DICTATION_HEAD_PATTERN);
  if (!head || head[0].trim().length === 0) return [];

  const body = text.match(DICTATION_BODY_PATTERN);
  if (body && text.slice(body[0].length).trim().length > 0) {
    return [{ start: 0, end: body[0].length }];
  }

  if (!DICTATION_MARKER_PATTERN.test(text)) return [];

  const spans: Span[] = [{ start: 0, end: head[0].length }];
  for (const pattern of [
    DICTATION_DATIVE_PATTERN,
    DICTATION_POLITE_PATTERN,
    DICTATION_ARTICLE_PATTERN,
    DICTATION_LIST_PATTERN,
  ]) {
    for (const match of text.matchAll(pattern)) {
      spans.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }
  const particle = text.match(DICTATION_PARTICLE_PATTERN);
  if (particle) spans.push({ start: particle.index!, end: particle.index! + particle[0].length });
  return spans;
}

// --- Explizite Titelangabe -------------------------------------------------

const EXPLICIT_TITLE_PATTERN = /\btitel\s+([^]+)$/iu;

/**
 * Führender Artikel fällt aus dem Titel (Entscheidung 03.09.26): „die Rechnung bezahlen"
 * wird zu „Rechnung bezahlen". Nur am Titelanfang und nur, wenn danach noch etwas steht —
 * ein Titel, der bloss aus einem Artikel besteht, bleibt lieber unangetastet.
 */
/** Modalpartikeln, die nach dem Rahmen vorne stehen bleiben: „noch die Mail schreiben". */
const LEADING_FILLER_PATTERN = /^(?:noch|mal|schon|endlich|unbedingt|wieder)\s+(?=\S)/iu;

const LEADING_ARTICLE_PATTERN =
  /^(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)\s+(?=\S)/iu;

function stripLeadingArticle(title: string): string {
  // Zweimal abwechselnd: „noch die Mail" braucht erst Füllwort, dann Artikel.
  let result = title;
  for (let pass = 0; pass < 2; pass++) {
    result = result.replace(LEADING_FILLER_PATTERN, '').replace(LEADING_ARTICLE_PATTERN, '');
  }
  return result;
}

// --- Titel-Rückbau ---------------------------------------------------------

/**
 * Was nach dem Ausschneiden übrig bleibt, ist oft noch kein Titel, sondern ein
 * Satzfragment: „kommt der Handwerker", „zum Zahnarzt", „treff ich Anna",
 * „den Müll rauszubringen". Diese Stufe baut daraus die Grundform.
 *
 * Alles hier ist absichtlich eng gefasst — geschlossene Wortlisten statt allgemeiner
 * Morphologie. Ein zu breiter Rückbau zerstört Titel, die zufällig so aussehen; die
 * Fälle unter „Rahmenwort nur zufällig vorn" in `gold/curated.ts` halten das fest.
 */

/** Trennbare Präfixe, die den zu-Infinitiv einschliessen: „rauszubringen". */
const SEPARABLE_PREFIXES =
  'ab|an|auf|aus|bei|durch|ein|fern|fest|her|hin|los|mit|nach|vor|weg|wieder|zurück|zusammen|raus|rein|rauf|runter|rüber|hoch|weiter|zu';
const INFIXED_ZU_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(${SEPARABLE_PREFIXES})zu(\p{Ll}+)(?![\p{L}\p{N}_])`,
  'giu',
);
/**
 * Freistehendes „zu" vor einem Infinitiv: „das Auto zu tanken".
 * Nur vor einem **klein** geschriebenen Wort auf -en — sonst fiele „Geschenk zu
 * Weihnachten" auseinander.
 */
// Kein `i`-Flag: das machte `\p{Ll}` wirkungslos, und „Geschenk zu Weihnachten
// besorgen" verlor sein „zu".
const FREE_ZU_PATTERN = /(?<![\p{L}\p{N}_])zu\s+(\p{Ll}[\p{L}]*e[nr]n?)(?![\p{L}\p{N}_])/gu;

/**
 * Finites Verb in Zweitstellung, das nach dem Herausschneiden des Datums vorn landet:
 * „Am Mittwoch kommt der Handwerker" → „kommt der Handwerker". Geschlossene Liste, damit
 * „Ist-Zustand dokumentieren" nicht zum „-Zustand" wird.
 */
const LEADING_FINITE_VERB_PATTERN =
  /^(?:ist|sind|war|waren|wird|werden|kommt|kommen|hat|haben|gibt|findet|beginnt|startet|endet|fällt)(?![\p{L}\p{N}_-])\s+(?=\S)/iu;

/**
 * Richtungspräposition mit verschmolzenem Artikel: „zum Zahnarzt" → „Zahnarzt".
 * Bewusst nur diese fünf — „mit", „bei" und „für" gehören zum Titel („Mit Max über das
 * Projekt sprechen", „Bei Rewe einkaufen").
 */
const LEADING_DIRECTION_PATTERN =
  /^(?:(?:zum|zur|ins|ans|aufs)(?![\p{L}\p{N}_-])\s+(?=\S)|nach\s+(?=\p{Lu}))/u;

/**
 * Verb-Pronomen-Inversion: „treff ich Anna" → „Anna treffen". Der Infinitiv entsteht
 * regelmässig aus dem Stamm (+ n statt + en, wenn der Stamm schon auf -e/-el/-er endet).
 */
const VERB_PRONOUN_PATTERN = /^(\p{Ll}+)\s+(?:ich|wir)(?![\p{L}\p{N}_])\s+(\S.*)$/u;
/**
 * Dasselbe mit trennbarem Verb: „ruf ich Oma an" → „Oma anrufen". Ohne diesen Zweig
 * bliebe das Partikel als eigenes Wort stehen („Oma an rufen").
 */
const VERB_PRONOUN_PARTICLE_PATTERN = new RegExp(
  String.raw`^(\p{Ll}+)\s+(?:ich|wir)(?![\p{L}\p{N}_])\s+(\S.*?)\s+(${SEPARABLE_PREFIXES})$`,
  'u',
);

function toInfinitive(stem: string): string {
  if (/e[lr]$/u.test(stem)) return `${stem}n`;
  if (/e$/u.test(stem)) return `${stem}n`;
  return `${stem}en`;
}

/**
 * Subjekt plus finites Verb am Titelanfang. Ob auch das Verb fällt, entscheidet der
 * Rest: steht am Ende ein Infinitiv, war das Verb nur Hilfsverb („wir gehen morgen
 * essen" → „essen"). Sonst trägt es selbst den Inhalt und bleibt stehen
 * („wir essen bei Müllers" → „essen bei Müllers").
 */
const SUBJECT_VERB_PATTERN = /^(?:[Ii]ch|[Ww]ir|[Ee]r|[Ss]ie|[Ee]s)\s+(\p{Ll}+)\s+(\S.*)$/u;
const TRAILING_INFINITIVE_PATTERN = /(?:^|\s)\p{Ll}[\p{L}]*e[nr]n?$/u;

/**
 * @param frameRemoved Ob vor dem Titel ein **Sprechrahmen** stand (Kommandopräfix,
 *   Diktatkopf, Kommandosuffix). Nur dann ist der Rest ein Fragment, dessen erster
 *   Buchstabe gross gehört — nach einer blossen Zeitangabe bleibt die Schreibweise des
 *   Nutzers stehen („in einer Woche nachfassen" → „nachfassen").
 * @param leadingRemoved Ob am Textanfang überhaupt etwas weggeschnitten wurde. Nur dann
 *   ist ein finites Verb vorn der Rest eines Satzes („Am Mittwoch kommt der Handwerker")
 *   — sonst ist es der Titel selbst und bleibt („Wird gelöscht", „Zur Post gehen").
 */
function refineTitle(title: string, frameRemoved: boolean, leadingRemoved: boolean): string {
  let result = title;
  const before = result;

  // 1 — zu-Infinitiv auflösen: „rauszubringen" → „rausbringen", „zu tanken" → „tanken".
  result = result.replace(INFIXED_ZU_PATTERN, '$1$2').replace(FREE_ZU_PATTERN, '$1');

  // 2 — Inversion umstellen, bevor Schritt 3 das Verb für einen Satzkopf hält.
  // Subjekt + Verb steht für sich: das Muster verlangt ein Pronomen und ein klein
  // geschriebenes Verb, das ist eng genug ohne Positionsbedingung.
  const subjectVerb = result.match(SUBJECT_VERB_PATTERN);
  if (subjectVerb) {
    result = TRAILING_INFINITIVE_PATTERN.test(subjectVerb[2])
      ? subjectVerb[2]
      : `${subjectVerb[1]} ${subjectVerb[2]}`;
  }

  // Alles Weitere setzt voraus, dass vorn wirklich etwas abgeschnitten wurde — sonst
  // ist ein führendes Verb der Titel selbst („Wird gelöscht"), kein Satzrest.
  if (!leadingRemoved) {
    if (result === before && !frameRemoved) return result;
    return result.charAt(0).toUpperCase() + result.slice(1);
  }

  const invertedParticle = result.match(VERB_PRONOUN_PARTICLE_PATTERN);
  const inverted = invertedParticle ? null : result.match(VERB_PRONOUN_PATTERN);
  if (invertedParticle) {
    result = `${invertedParticle[2]} ${invertedParticle[3]}${toInfinitive(invertedParticle[1])}`;
  } else if (inverted) {
    result = `${inverted[2]} ${toInfinitive(inverted[1])}`;
  }

  // 3/4 — Satzkopf und Richtungspräposition, danach greift der Artikel erneut
  // („kommt der Handwerker" → „der Handwerker" → „Handwerker").
  for (let pass = 0; pass < 2; pass++) {
    result = result
      .replace(LEADING_FINITE_VERB_PATTERN, '')
      .replace(LEADING_DIRECTION_PATTERN, '');
    result = stripLeadingArticle(result);
  }

  if (result === before && !frameRemoved) return result;
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function edgeTrim(text: string): string {
  return (
    text
      .replace(/\s+/g, ' ')
      // Ein herausgeschnittener Span lässt sein Satzzeichen zurück: „Zahnarzt , danach"
      // und „Milch,, Brot" entstehen erst beim Entfernen, nicht beim Sprechen.
      .replace(/\s+([,;:.!?])/g, '$1')
      .replace(/([,;:])\s*(?=[,;:])/g, '')
      .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '')
      .trim()
  );
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
  /**
   * Ende einer genannten Spanne, sonst `null`. Bei einer Uhrzeitspanne derselbe Tag mit
   * der Endzeit („von 10 bis 12"), bei einer Datumsspanne der letzte Tag („vom 3. bis
   * 10. März"). Ob daraus ein Zeit-Termin oder ein mehrtägiger ganztägiger wird,
   * entscheidet `eventFieldsFromDraft` am Kalendertag-Vergleich.
   */
  endAt: Date | null;
  /** Erkannter Wiederholungsausdruck, `null` wenn keiner. Wird bewusst nicht
   * gespeichert — siehe `RecurrenceValue`. */
  recurrence: RecurrenceValue | null;
  title: string;
  needsConfirmation: boolean;
  /** #691: Grundtext für die Feld-Konfidenz „Datum"/„Uhrzeit", `null` wenn nicht geraten. */
  dateGuessReason: string | null;
  timeGuessReason: string | null;
}

/** Uhrzeit ohne Datum: "heute", wenn sie noch in der Zukunft liegt, sonst "morgen" (AC2) —
 * "heute" ist der *logische* Tag (R6, #689): ob die Zeit schon vorbei ist, entscheidet
 * weiter die echte Uhr (`now` unverändert im Vergleich), nur der Basistag verschiebt sich. */
function resolveTimeOnlyDate(time: TimeValue, now: Date): Date {
  const candidate = logicalDayStart(now);
  candidate.setHours(time.hours, time.minutes, 0, 0);
  return candidate > now ? candidate : addDays(candidate, 1);
}

/**
 * Die eine Stelle, die Datum, Uhrzeit und Titel gemeinsam aus einer Freitext-Eingabe
 * gewinnt — von `parseTaskInput` (Aufgaben-FAB) und `recognizeLocally` (#621,
 * Erfassungs-Klassifikator) gleichermaßen benutzt, damit R3 überall identisch gilt.
 */
export function analyzeText(text: string, now: Date = new Date()): TextAnalysis {
  const recurrenceMatch = findRecurrence(text);
  const dateCandidate = findDateCandidate(text, now);
  const timeCandidate = findTimeCandidate(text, now);

  let date: Date | null = null;
  const hasExplicitTime = timeCandidate !== null;
  // #691: "keine Uhrzeit gesagt" gilt nur, wenn überhaupt ein Datum gefunden wurde und
  // dafür eine Uhrzeit fehlt (der Default 09:00 unten) — ein reiner Zeit-ohne-Datum-Fund
  // hat sehr wohl eine gesagte Uhrzeit, nur kein Datum dazu.
  let dateGuessReason: string | null = null;
  let timeGuessReason: string | null = null;
  if (dateCandidate) {
    date = new Date(dateCandidate.value.date);
    dateGuessReason = dateCandidate.value.guessReason;
    if (timeCandidate) {
      date.setHours(timeCandidate.value.hours, timeCandidate.value.minutes, 0, 0);
      timeGuessReason = timeCandidate.value.guessReason;
    } else {
      date.setHours(9, 0, 0, 0);
      timeGuessReason = NO_TIME_GIVEN_REASON;
    }
  } else if (timeCandidate) {
    date = resolveTimeOnlyDate(timeCandidate.value, now);
    timeGuessReason = timeCandidate.value.guessReason;
  }

  // Nennt der Wiederholungsausdruck genau einen Wochentag, ist damit auch die erste
  // Fälligkeit gesagt — „immer freitags" trägt kein eigenes Datum, meint aber Freitag.
  // Bei „werktags" (fünf Tage) oder „täglich" bleibt sie offen.
  if (date === null && recurrenceMatch?.value.byWeekday?.length === 1) {
    const logicalStart = logicalDayStart(now);
    const diff = (recurrenceMatch.value.byWeekday[0] - logicalStart.getDay() + 7) % 7;
    date = addDays(logicalStart, diff);
    date.setHours(timeCandidate?.value.hours ?? 9, timeCandidate?.value.minutes ?? 0, 0, 0);
  }

  // Spannen-Ende: erst die Uhrzeit am selben Tag, dann — falls genannt — der letzte Tag
  // einer Datumsspanne, der die Uhrzeitlesart überschreibt.
  let endAt: Date | null = null;
  if (date !== null && timeCandidate) {
    const rangeEnd = findTimeRangeEnd(text, timeCandidate.value.hours);
    if (rangeEnd) {
      endAt = new Date(date);
      endAt.setHours(rangeEnd.hours, rangeEnd.minutes, 0, 0);
    }
  }
  const dateRangeEnd = findDateRangeEnd(text, now);
  if (dateRangeEnd) endAt = dateRangeEnd;

  const needsConfirmation = timeCandidate?.value.needsConfirmation ?? false;

  const explicitTitle = findExplicitTitle(text);
  if (explicitTitle !== null) {
    return {
      date,
      hasExplicitTime,
      endAt,
      recurrence: recurrenceMatch?.value ?? null,
      title: explicitTitle,
      needsConfirmation,
      dateGuessReason,
      timeGuessReason,
    };
  }

  const dateSpan = dateCandidate ? { start: dateCandidate.start, end: dateCandidate.end } : null;
  const timeSpan = timeCandidate ? { start: timeCandidate.start, end: timeCandidate.end } : null;
  const anchors = [dateSpan, timeSpan].filter((span): span is Span => span !== null);

  const prefixSpans = findCommandPrefixSpans(text);
  const terminSpan =
    prefixSpans.length === 0 ? findTerminPrefixSpan(text, dateSpan, timeSpan) : null;
  const connectorSpans = findConnectorSpans(text, anchors);
  const suffixSpan = findCommandSuffixSpan(text);
  // Beide Mengen laufen immer: ein Altpräfix wie „erstelle" deckt nur den Wortanfang ab,
  // das „mir bitte einen Termin" dahinter braucht weiter die Diktat-Grammatik.
  // Überlappende Spans sind unschädlich — `removeSpans` schneidet sie zusammen.
  const dictationSpans = findDictationSpans(text);

  const removalSpans = [
    ...prefixSpans,
    ...dictationSpans,
    ...(recurrenceMatch ? [{ start: recurrenceMatch.start, end: recurrenceMatch.end }] : []),
    ...(terminSpan ? [terminSpan] : []),
    ...(suffixSpan ? [suffixSpan] : []),
    ...anchors,
    ...connectorSpans,
  ];
  const frameRemoved =
    prefixSpans.length > 0 || dictationSpans.length > 0 || terminSpan !== null || suffixSpan !== null;
  // „Am Textanfang" heisst: der erste Span sitzt vor dem ersten inhaltlichen Zeichen.
  const leadingRemoved = removalSpans.some((span) => isPunctuationOnly(text, 0, span.start));
  const title = refineTitle(
    stripLeadingArticle(edgeTrim(removeSpans(text, removalSpans))),
    frameRemoved,
    leadingRemoved,
  );
  return {
    date,
    hasExplicitTime,
    endAt,
    recurrence: recurrenceMatch?.value ?? null,
    title,
    needsConfirmation,
    dateGuessReason,
    timeGuessReason,
  };
}

export function parseTaskInput(text: string, now: Date = new Date()): ParsedTaskInput {
  const { date, title, needsConfirmation, dateGuessReason, timeGuessReason } = analyzeText(text, now);
  return {
    title,
    dueAt: date ? date.toISOString() : null,
    needsConfirmation,
    dateGuessReason,
    timeGuessReason,
  };
}
