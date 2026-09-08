// Bildet den Namen der Session-Datei je Rolle (#356, A von #356; #1136).
//
// Bau- (cwd .../issue-<nr>) und Denk-Laeufe (cwd .../readonly-<nr>) hatten bis
// hierher denselben Schluessel 'session-<nr>' geteilt, obwohl die
// Claude-CLI eine Session ans Arbeitsverzeichnis bindet. Ein Bau-Lauf, der
// die Session eines vorangegangenen Plan-/Recherche-Laufs erbte, uebergab sie
// per --resume in einem cwd, das die CLI nie gesehen hatte -> "No
// conversation found" (#353).
//
// `check` lief anfangs in der Bau-Familie mit -- derselbe Fehler nur mit
// vertauschten Rollen: der Pruef-Lauf uebernahm den Schluessel des Bauers,
// uebergab dessen Session per --resume in einem Readonly-Worktree, den die
// CLI nie gesehen hatte, und ueberschrieb hinterher den Bau-Stand (#1136).
// Eine dritte Familie mit eigenem Schluessel `session-check-<nr>` trennt den
// Pruef-Lauf sauber vom Bauer.
//
// Alle drei Familien behalten das Praefix 'session-', damit
// cleanupStateDir() (Praefix-Raster) unveraendert fuer alle drei greift.
import type { RunRole } from './select.js';

export type SessionFamily = 'build' | 'think' | 'check';

export function sessionFamily(role: RunRole): SessionFamily {
  if (role === 'plan' || role === 'research') return 'think';
  if (role === 'check') return 'check';
  return 'build';
}

export function sessionKey(issue: number, role: RunRole): string {
  const family = sessionFamily(role);
  if (family === 'think') return `session-think-${issue}`;
  if (family === 'check') return `session-check-${issue}`;
  return `session-${issue}`;
}
