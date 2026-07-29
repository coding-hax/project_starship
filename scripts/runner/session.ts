// Bildet den Namen der Session-Datei je Rolle (#356, A von #356).
//
// Bau- (cwd .../issue-<nr>) und Denk-Laeufe (cwd .../readonly-<nr>) hatten bis
// hierher denselben Schluessel 'session-<nr>' geteilt, obwohl die
// Claude-CLI eine Session ans Arbeitsverzeichnis bindet. Ein Bau-Lauf, der
// die Session eines vorangegangenen Plan-/Recherche-Laufs erbte, uebergab sie
// per --resume in einem cwd, das die CLI nie gesehen hatte -> "No
// conversation found" (#353).
//
// Beide Familien behalten das Praefix 'session-', damit cleanupStateDir()
// (Praefix-Raster) unveraendert fuer beide greift.
import type { RunRole } from './select.js';

export type SessionFamily = 'build' | 'think';

export function sessionFamily(role: RunRole): SessionFamily {
  return role === 'plan' || role === 'research' ? 'think' : 'build';
}

export function sessionKey(issue: number, role: RunRole): string {
  return sessionFamily(role) === 'think' ? `session-think-${issue}` : `session-${issue}`;
}
