import { cleanTitle, extractDateTimeSlot } from '../tasks/parse-task-input';
import { matchHabit } from './habit-match';
import type { CaptureDraft, CaptureKind, Recognizer } from './types';

/**
 * Lokaler Erkenner — Signale punkten statt If-Kaskade (sonst hängt das Ergebnis an der
 * Zweig-Reihenfolge). Zwei Regeln, die man leicht falsch baut (issue #621):
 *
 * - Die Modul-Registry filtert NACH dem Punkten, nicht davor (`applyAllowedKinds`).
 * - Erledigen schlägt Anlegen: das `habit_check`-Signal (Verb *und* Habit-Treffer) ist
 *   das mit Abstand stärkste, unabhängig davon, welches Vokabular sonst noch trifft.
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
const HAKE_PATTERN = word('hake');
const AB_PATTERN = word('ab');

function hasCompletionVerb(text: string): boolean {
  return (
    ABHAKEN_PATTERN.test(text) ||
    ABGEHAKT_PATTERN.test(text) ||
    ERLEDIGT_PATTERN.test(text) ||
    GEMACHT_PATTERN.test(text) ||
    (HAKE_PATTERN.test(text) && AB_PATTERN.test(text))
  );
}

const EVENT_VOCAB_PATTERNS = [word('termin'), word('treffen'), word('meeting'), /\bbei\s+dr\.?/iu];
const TASK_VOCAB_PATTERNS = [word('erinnere mich'), word('nicht vergessen'), word('muss noch')];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const SCORE = {
  habitCheck: 100,
  eventTime: 60,
  taskDateOnly: 40,
  eventVocab: 20,
  taskVocab: 20,
  taskBaseline: 1,
};

interface Signals {
  completionVerb: boolean;
  habitMatched: boolean;
  hasDate: boolean;
  hasExplicitTime: boolean;
  eventVocab: boolean;
  taskVocab: boolean;
}

function classify(signals: Signals): CaptureKind {
  const scores: Record<CaptureKind, number> = {
    task: SCORE.taskBaseline,
    event: 0,
    habit_check: 0,
  };

  if (signals.completionVerb && signals.habitMatched) {
    scores.habit_check += SCORE.habitCheck;
  }
  if (signals.hasExplicitTime) {
    scores.event += SCORE.eventTime;
  } else if (signals.hasDate) {
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
  return winner;
}

// Nur die Signalwörter, die `cleanTitle`s FILLER_PATTERN aus parse-task-input.ts noch
// nicht kennt (das deckt "termin"/"erstelle"/"erinnere mich an" bereits ab).
function stripSignalTokens(text: string, signals: Signals): string {
  let stripped = text;
  if (signals.completionVerb) {
    stripped = stripped
      .replace(new RegExp(ABHAKEN_PATTERN, 'giu'), ' ')
      .replace(new RegExp(ABGEHAKT_PATTERN, 'giu'), ' ')
      .replace(new RegExp(ERLEDIGT_PATTERN, 'giu'), ' ')
      .replace(new RegExp(GEMACHT_PATTERN, 'giu'), ' ')
      .replace(new RegExp(HAKE_PATTERN, 'giu'), ' ')
      .replace(new RegExp(AB_PATTERN, 'giu'), ' ');
  }
  if (signals.eventVocab) {
    stripped = stripped
      .replace(new RegExp(word('treffen'), 'giu'), ' ')
      .replace(new RegExp(word('meeting'), 'giu'), ' ')
      .replace(/\bbei\s+dr\.?/giu, ' ');
  }
  if (signals.taskVocab) {
    stripped = stripped
      .replace(new RegExp(word('nicht vergessen'), 'giu'), ' ')
      .replace(new RegExp(word('muss noch'), 'giu'), ' ');
  }
  return stripped;
}

function buildTitle(rawText: string, remaining: string, signals: Signals): string {
  const cleaned = cleanTitle(stripSignalTokens(remaining, signals));
  return cleaned || rawText.trim();
}

export const recognizeLocally: Recognizer = (text, ctx) => {
  const { date, hasExplicitTime, remaining } = extractDateTimeSlot(text, ctx.now);
  const habitMatch = matchHabit(text, ctx.habits);

  const signals: Signals = {
    completionVerb: hasCompletionVerb(text),
    habitMatched: habitMatch.matched,
    hasDate: date !== null,
    hasExplicitTime,
    eventVocab: matchesAny(text, EVENT_VOCAB_PATTERNS),
    taskVocab: matchesAny(text, TASK_VOCAB_PATTERNS),
  };

  const scored = classify(signals);
  // Modul-Registry filtert NACH dem Punkten: gewinnt eine Art, die der Aufrufer nicht
  // erlaubt, degradiert das Ergebnis zu `task` — es fällt nicht weg.
  const kind: CaptureKind = ctx.allowedKinds.includes(scored) ? scored : 'task';

  const draft: CaptureDraft = {
    kind,
    title: buildTitle(text, remaining, signals),
    dueAt: kind === 'habit_check' ? null : date ? date.toISOString() : null,
    habitId: kind === 'habit_check' ? habitMatch.habitId : null,
    confidence: kind === 'habit_check' ? habitMatch.confidence : 'high',
  };

  return { items: [draft] };
};
