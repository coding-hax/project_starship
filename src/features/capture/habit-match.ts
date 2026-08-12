import type { CaptureConfidence } from './types';

/**
 * Fuzzy-Match ohne Dependency (Regel 3) — bei ~10 Gewohnheiten reicht Tokenüberlappung.
 * Kein Levenshtein: Diktat verhört sich (anderes, phonetisch ähnliches Wort), es
 * vertippt sich nicht (verrutschte Buchstaben) — Edit-Distanz träfe den falschen Fehler.
 */

export interface HabitMatch {
  /** true, sobald irgendeine Gewohnheit auch nur teilweise überlappt (Signal für den Klassifikator). */
  matched: boolean;
  /** nur bei genau einem eindeutig besten Treffer gesetzt. */
  habitId: string | null;
  confidence: CaptureConfidence;
}

const NO_MATCH: HabitMatch = { matched: false, habitId: null, confidence: 'low' };

// Verneinung schlägt jeden Treffer (issue #687 AK6) — "Sport heute nicht gemacht" darf
// nie als erledigt durchgehen, das ist der teuerste Fehler im ganzen Korpus, weil er
// still Daten verfälscht. Bewusst satzweit statt an die Verb-Nähe gebunden: ein einziges
// "nicht" im Satz reicht, um jeden Habit-Treffer zu kassieren.
const NEGATION_PATTERN = /(?<![\p{L}\p{N}_])nicht(?![\p{L}\p{N}_])/iu;

const COMBINING_DIACRITICS_PATTERN = /[̀-ͯ]/g;

function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(COMBINING_DIACRITICS_PATTERN, '');
}

function tokenize(text: string): string[] {
  return foldDiacritics(text.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

type Strength = 1 | 2;

export function matchHabit(text: string, habits: { id: string; name: string }[]): HabitMatch {
  if (NEGATION_PATTERN.test(text)) return NO_MATCH;

  const textTokens = new Set(tokenize(text));

  const scored = habits
    .map((habit) => {
      const nameTokens = tokenize(habit.name);
      const hits = nameTokens.filter((token) => textTokens.has(token)).length;
      const strength: Strength | 0 = hits === 0 ? 0 : hits === nameTokens.length ? 2 : 1;
      return { habit, strength };
    })
    .filter((entry) => entry.strength > 0);

  if (scored.length === 0) return NO_MATCH;

  const bestStrength = Math.max(...scored.map((entry) => entry.strength));
  const top = scored.filter((entry) => entry.strength === bestStrength);

  if (top.length > 1) {
    return { matched: true, habitId: null, confidence: 'low' };
  }

  return {
    matched: true,
    habitId: top[0].habit.id,
    confidence: bestStrength === 2 ? 'high' : 'low',
  };
}
