import { analyzeText } from '../tasks/parse-task-input';
import { matchHabit } from './habit-match';
import type { CaptureDraft, CaptureKind, Recognizer } from './types';

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

export const recognizeLocally: Recognizer = (text, ctx) => {
  const { date, hasExplicitTime, title, needsConfirmation } = analyzeText(text, ctx.now);
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

  // R2 Regel 5 + AK4 (#688): eine geratene Nachtzeit oder eine regionale Kurzform senkt
  // die Konfidenz auch für task/event — Grundlage für `needsConfirmation` auf dem
  // Aufgaben-Pfad (route-capture.ts).
  const draft: CaptureDraft = {
    kind,
    title,
    dueAt: kind === 'habit_check' ? null : date ? date.toISOString() : null,
    habitId: kind === 'habit_check' ? habitMatch.habitId : null,
    confidence: kind === 'habit_check' ? habitMatch.confidence : needsConfirmation ? 'low' : 'high',
  };

  return { items: [draft] };
};
