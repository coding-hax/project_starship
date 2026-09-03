import { toDateKey } from '../habits/due-today';
import { analyzeText, logicalDayStart } from '../tasks/parse-task-input';
import { confidenceFromReason, isSubstantialTitle, titleConfidence } from './field-confidence';
import { matchHabit } from './habit-match';
import type { CaptureContext, CaptureDraft, CaptureKind, FieldMentions, Recognizer } from './types';

/**
 * Lokaler Erkenner — Signale punkten statt If-Kaskade (sonst hängt das Ergebnis an der
 * Zweig-Reihenfolge). Zwei Regeln, die man leicht falsch baut (issue #621):
 *
 * - Die Modul-Registry filtert NACH dem Punkten, nicht davor (`applyAllowedKinds`).
 * - Erledigen schlägt Anlegen: das `habit_check`-Signal (Verb *und* Habit-Treffer) ist
 *   das mit Abstand stärkste, unabhängig davon, welches Vokabular sonst noch trifft.
 *
 * Der Titel kommt vollständig aus `analyzeText` (#687, R3) — Termin-/Aufgaben-Vokabular
 * (z. B. "Meeting", "bei Dr.") bleibt im Titel stehen, auch wenn es hier die Art
 * mitentscheidet. Keine eigene Wort-Blacklist mehr.
 */

const WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
function word(pattern: string): RegExp {
  return new RegExp(`${WORD_BEFORE}${pattern}${WORD_AFTER}`, 'iu');
}

// "abhaken"/"abgehakt" als ein Wort, "hake ... ab" als trennbares Verb (kann Wörter
// dazwischen haben, z. B. "hake meine Routine Sport für heute ab").
const ABHAKEN_PATTERN = word('abhaken');
const ABGEHAKT_PATTERN = word('abgehakt');
const ERLEDIGT_PATTERN = word('erledigt');
const GEMACHT_PATTERN = word('gemacht');
// Goldkorpus: „geschafft" fehlte als einziges der vier gängigen Erledigungsverben.
const GESCHAFFT_PATTERN = word('geschafft');
// Gesprochene Erledigungsmeldungen ohne eigenes Verb: „Yoga hab ich heute schon",
// „Sport hab ich hinter mir". Als Phrase, nicht als blosses „schon" — sonst gälte
// „schon mal an Sport denken" als abgehakt.
const DONE_PHRASE_PATTERNS = [
  /\bhab(?:e)?\s+ich\s+(?:heute\s+)?schon\b/iu,
  /\bschon\s+(?:gemacht|erledigt|geschafft)\b/iu,
  /\bhab(?:e)?\s+ich\s+hinter\s+mir\b/iu,
  /\bist\s+(?:schon\s+)?(?:erledigt|durch|fertig)\b/iu,
];
const HAKE_PATTERN = word('hake');
const AB_PATTERN = word('ab');

/** Exportiert für `uebersicht-capture.tsx` (AK6, #687): erkennt einen Erledigungsverb-Versuch
 * auch dann, wenn `matchHabit` ihn (Verneinung oder kein Treffer) zu `task` degradiert. */
export function hasCompletionVerb(text: string): boolean {
  return (
    ABHAKEN_PATTERN.test(text) ||
    ABGEHAKT_PATTERN.test(text) ||
    ERLEDIGT_PATTERN.test(text) ||
    GEMACHT_PATTERN.test(text) ||
    GESCHAFFT_PATTERN.test(text) ||
    DONE_PHRASE_PATTERNS.some((pattern) => pattern.test(text)) ||
    (HAKE_PATTERN.test(text) && AB_PATTERN.test(text))
  );
}

// „Zahnarzttermin" enthält das Schlüsselwort und zählt deshalb mit — gesagt ist gesagt.
const EVENT_VOCAB_PATTERNS = [
  /(?<![\p{L}\p{N}_])\p{L}*termine?(?![\p{L}\p{N}_])/iu,
  word('treffen'),
  word('meeting'),
  /\bbei\s+dr\.?/iu,
];
// Entscheidung 03.09.26: die Art fällt an einem Schlüsselwort. „Aufgabe"/„Notiz"/„Todo"
// gehören deshalb hierher — vorher stand nur der Sprechrahmen drin.
const TASK_VOCAB_PATTERNS = [
  word('erinnere mich'), word('nicht vergessen'), word('muss noch'),
  word('aufgaben?'), word('todo'), word('notiz'), word('erinnerung'),
];
// #780: eigenes Vokabular fürs Routine-Intent-Wort — deckt "Routine …" und "Gewohnheit
// …", unabhängig von einem Erledigungsverb (dessen Signal bleibt `habitCheck` oben).
const ROUTINE_INTENT_PATTERNS = [word('routine'), word('gewohnheit')];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

// #780 E1: nur das FÜHRENDE Intent-Wort (plus optionales "neue") — ein Kommandopräfix
// wie "erstelle …", kein allgemeiner Vokabular-Filter (R3 aus #687 bleibt für den Titel
// sonst unangetastet, greift nur im `newHabit`-Zweig unten).
const LEADING_ROUTINE_WORD_PATTERN = /^(?:neue\s+)?(?:routine|gewohnheit)\s+/iu;

function stripLeadingRoutineWord(title: string): string {
  return title.replace(LEADING_ROUTINE_WORD_PATTERN, '').trim();
}

const SCORE = {
  habitCheck: 100,
  routineIntent: 80,
  // Entscheidung 03.09.26: ein Schlüsselwort (Termin/Meeting/Treffen bzw. Aufgabe/Notiz)
  // entscheidet die Art allein. Vorher punktete eine blosse Uhrzeit 60 für `event` und
  // machte aus „um 8 Brötchen holen" einen Kalendertermin.
  eventVocab: 100,
  taskVocab: 100,
  // Datum ODER Uhrzeit — ohne Schlüsselwort bleibt beides eine Aufgabe.
  taskDateOnly: 40,
  taskBaseline: 1,
};

interface Signals {
  completionVerb: boolean;
  habitMatched: boolean;
  routineIntent: boolean;
  hasDate: boolean;
  hasExplicitTime: boolean;
  eventVocab: boolean;
  taskVocab: boolean;
}

/** #691: Abstand zwischen Sieger und Zweitem im Ranking unter dieser Schwelle ->
 * Feld-Konfidenz „Art" gilt als geraten ("Aufgabe oder Termin unklar"). */
const KIND_MARGIN_THRESHOLD = 20;

interface ClassifyResult {
  kind: CaptureKind;
  ambiguous: boolean;
  /** #780: `true`, wenn `task` einzig mangels jedem Signal gewinnt (die Baseline) —
   * keine echte Entscheidung, sondern der sichere Rückfall ohne jede Grundlage. */
  provisional: boolean;
}

function classify(signals: Signals): ClassifyResult {
  const scores: Record<CaptureKind, number> = {
    task: SCORE.taskBaseline,
    event: 0,
    habit_check: 0,
  };

  if (signals.completionVerb && signals.habitMatched) {
    scores.habit_check += SCORE.habitCheck;
  }
  if (signals.routineIntent) {
    scores.habit_check += SCORE.routineIntent;
  }
  if (signals.hasDate || signals.hasExplicitTime) {
    scores.task += SCORE.taskDateOnly;
  }
  if (signals.eventVocab) {
    scores.event += SCORE.eventVocab;
  }
  if (signals.taskVocab) {
    scores.task += SCORE.taskVocab;
  }

  let winner: CaptureKind = 'task';
  for (const kind of ['habit_check', 'event', 'task'] as const) {
    if (scores[kind] > scores[winner]) winner = kind;
  }
  const runnerUp = Math.max(
    ...(['habit_check', 'event', 'task'] as const)
      .filter((kind) => kind !== winner)
      .map((kind) => scores[kind]),
  );
  // `runnerUp === 0` heißt: kein einziges Signal hat für eine andere Art gepunktet,
  // `task`s Baseline (SCORE.taskBaseline) gewinnt nur mangels Alternative — das ist der
  // sichere Rückfall, keine knappe Entscheidung (sonst wäre praktisch jeder unmarkierte
  // Satz "geraten", die Baseline liegt ja immer unter der Schwelle).
  const ambiguous = runnerUp > 0 && scores[winner] - runnerUp < KIND_MARGIN_THRESHOLD;
  const provisional = winner === 'task' && scores.task === SCORE.taskBaseline;
  return { kind: winner, ambiguous, provisional };
}

const LOG_DATE_LOOKBACK_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** R7 (#689): ein Datum im Abhaken-Satz steuert den Log-Tag, nicht eine Fälligkeit —
 * erlaubt bis 7 Tage rückwärts. Weiter zurück oder ein Datum in der Zukunft werden
 * ignoriert (Log-Tag bleibt der logische Heute-Tag, R6), damit kein verhörtes Datum
 * still eine alte Streak verfälscht. `date` kommt unverändert aus `analyzeText` — für
 * ein Datum ohne Jahr springt dessen eigene Vorwärts-Logik (Fälligkeiten sind
 * zukunftsgerichtet) ggf. schon selbst übers Ziel hinaus ins nächste Jahr; das landet
 * hier dann ohnehin im "Zukunft"-Zweig und damit beim gleichen Ergebnis: ignoriert. */
function resolveLogDate(date: Date | null, now: Date): string {
  const today = logicalDayStart(now);
  if (date === null) return toDateKey(today);
  const candidateDay = new Date(date);
  candidateDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - candidateDay.getTime()) / MS_PER_DAY);
  if (diffDays < 0 || diffDays > LOG_DATE_LOOKBACK_DAYS) return toDateKey(today);
  return toDateKey(candidateDay);
}

const KIND_AMBIGUOUS_REASON = 'Aufgabe oder Termin unklar';
const HABIT_AMBIGUOUS_REASON = 'unsicherer Gewohnheitstreffer';

export const recognizeLocally: Recognizer = (text, ctx) => {
  const { date, hasExplicitTime, title, needsConfirmation, dateGuessReason, timeGuessReason } =
    analyzeText(text, ctx.now);
  const habitMatch = matchHabit(text, ctx.habits);

  const signals: Signals = {
    completionVerb: hasCompletionVerb(text),
    habitMatched: habitMatch.matched,
    routineIntent: matchesAny(text, ROUTINE_INTENT_PATTERNS),
    hasDate: date !== null,
    hasExplicitTime,
    eventVocab: matchesAny(text, EVENT_VOCAB_PATTERNS),
    taskVocab: matchesAny(text, TASK_VOCAB_PATTERNS),
  };

  const classified = classify(signals);
  // Modul-Registry filtert NACH dem Punkten: gewinnt eine Art, die der Aufrufer nicht
  // erlaubt, degradiert das Ergebnis zu `task` — es fällt nicht weg.
  const kind: CaptureKind = ctx.allowedKinds.includes(classified.kind) ? classified.kind : 'task';
  // Eine Degradierung ist eine bewusste Regel (der sichere Rückfall), keine unklare
  // Rangfolge mehr — die Feld-Konfidenz "Art" bleibt dann `high`.
  const kindDegraded = kind !== classified.kind;
  // #780: eine Degradierung ist selbst schon eine (übersteuerte) Entscheidung, kein
  // "kein Signal" — bleibt deshalb nicht provisorisch.
  const provisional = classified.provisional && !kindDegraded;
  // #780 E2/E3: "Routine …" ohne Erledigungsverb ist eine neue Gewohnheit, kein Treffer
  // auf eine bestehende — auch wenn `matchHabit` (rein textuell, ohne Verb-Kontext) eine
  // findet. Kein Erledigungsverb heißt kein Abhaken-Recht.
  const newHabit = kind === 'habit_check' && !signals.completionVerb;
  const resolvedTitle = newHabit ? stripLeadingRoutineWord(title) : title;

  // R2 Regel 5 + AK4 (#688): eine geratene Nachtzeit oder eine regionale Kurzform senkt
  // die Konfidenz auch für task/event — Grundlage für `needsConfirmation` auf dem
  // Aufgaben-Pfad (route-capture.ts). Unverändert seit vor #691, unabhängig von der
  // Feld-Konfidenz unten.
  const draft: CaptureDraft = {
    kind,
    title: resolvedTitle,
    dueAt: kind === 'habit_check' ? null : date ? date.toISOString() : null,
    habitId: kind === 'habit_check' ? (newHabit ? null : habitMatch.habitId) : null,
    logDate: kind === 'habit_check' && !newHabit ? resolveLogDate(date, ctx.now) : null,
    needsConfirmation,
    confidence: {
      kind: confidenceFromReason(!kindDegraded && classified.ambiguous ? KIND_AMBIGUOUS_REASON : null),
      title: titleConfidence(resolvedTitle),
      date: confidenceFromReason(dateGuessReason),
      time: confidenceFromReason(timeGuessReason),
      habit: confidenceFromReason(
        habitMatch.matched && habitMatch.confidence === 'low' ? HABIT_AMBIGUOUS_REASON : null,
      ),
    },
    provisional,
    newHabit,
  };

  return { items: [draft] };
};

/**
 * Was eine einzelne Äußerung nennt (issue #716) — Grundlage für `mergeDraft`
 * (route-capture.ts): welche Felder überschreibt diese Äußerung, welche bleiben
 * unangetastet stehen. Läuft über dieselben Primitive wie `recognizeLocally` oben,
 * unabhängig von dessen Art-Klassifikation (die bleibt nach der ersten Übernahme fix,
 * Entscheidung C des Plans).
 */
export function utteranceMentions(text: string, ctx: CaptureContext): FieldMentions {
  const { date, title } = analyzeText(text, ctx.now);
  const habitMatch = matchHabit(text, ctx.habits);
  return {
    titleSubstantial: isSubstantialTitle(title),
    due: date !== null,
    habit: habitMatch.matched,
  };
}
