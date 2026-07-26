// .runner/ raeumt sich auf (#64), portiert aus Bash in S6 (#203).
//
// tier-/failcount-/opus-build-/opus-cap-msg-/session--Dateien geschlossener
// Tickets blieben sonst fuer immer liegen. Einmal PRO TICK faellt alles weg,
// was aelter als sieben Tage ist. Ausdruecklich verschont: 'limit-until' (kein
// Ticketbezug, faellt schon durch das Praefix-Raster) und die Session-Datei des
// GERADE laufenden Tickets, egal wie alt sie ist.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GhAdapter } from './gh.js';

const PREFIXES = ['tier-', 'failcount-', 'opus-build-', 'opus-cap-msg-', 'session-'];
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Welches Ticket laeuft gerade? Dessen Session-Datei ueberlebt die Runde.
// Ein Fehlschlag von `gh` ist kein Grund abzubrechen -- dann wird eben nichts
// verschont, exakt wie im Bash-Original (dort schluckte `2>/dev/null` den
// Fehler und `keep_session` blieb leer).
function runningIssue(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue', 'list', '--label', 'in-progress', '--state', 'open',
      '--limit', '5', '--json', 'number', '-q', '.[0].number // empty',
    ]).trim();
  } catch {
    return '';
  }
}

export function cleanupStateDir(baseDir: string, gh: GhAdapter, now: number): string[] {
  const keep = runningIssue(gh);
  const keepFile = keep ? `session-${keep}` : '';
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return removed;
  }

  for (const name of entries) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    if (name === keepFile) continue;

    const path = join(baseDir, name);
    try {
      const stat = statSync(path);
      // Unterverzeichnisse bleiben unangetastet: `find -maxdepth 1 -delete`
      // haette an einem nicht leeren Verzeichnis ohnehin nur gemeckert.
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs <= MAX_AGE_MS) continue;
      unlinkSync(path);
      removed.push(name);
    } catch {
      // Datei ist zwischen readdir und unlink verschwunden -- egal, Ziel erreicht.
    }
  }

  return removed;
}
