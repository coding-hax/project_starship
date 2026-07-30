// .runner/ raeumt sich auf (#64), portiert aus Bash in S6 (#203).
//
// tier-/failcount-/opus-build-/opus-cap-msg-/session--Dateien geschlossener
// Tickets blieben sonst fuer immer liegen. Einmal PRO TICK faellt alles weg,
// was aelter als sieben Tage ist. Ausdruecklich verschont: 'limit-until' (kein
// Ticketbezug, faellt schon durch das Praefix-Raster) und die Session-Datei des
// GERADE laufenden Tickets, egal wie alt sie ist.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimAdapter } from './claim.js';
import type { GhAdapter } from './gh.js';

const PREFIXES = ['tier-', 'failcount-', 'opus-build-', 'opus-cap-msg-', 'session-'];
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Welches Ticket laeuft gerade IN DIESEM SLOT? Dessen Session-Datei ueberlebt
// die Runde. Korrektur 5 (#204): eine globale Abfrage (`--label in-progress`,
// `.[0]`) waere bei mehreren Slots falsch -- jeder Slot saehe womoeglich das
// in-progress-Ticket eines ANDEREN Slots als "das laufende" an, verschonte
// dessen Session-Datei und loeschte dabei seine eigene (nach 7 Tagen, also
// gerade dann, wenn der Sitzungskontext am meisten wert ist). Der eigene
// Claim (`claims.list()` gefiltert auf `slotId`) ist die einzige Quelle, die
// zuverlaessig NUR die Tickets DIESES Slots nennt.
// Ein Fehlschlag von `gh` ist kein Grund abzubrechen -- dann wird eben nichts
// verschont, exakt wie im Bash-Original (dort schluckte `2>/dev/null` den
// Fehler und `keep_session` blieb leer).
function runningIssue(gh: GhAdapter, claims: ClaimAdapter, slotId: string): string {
  const owned = claims.list().filter((issue) => claims.readSlot(issue) === slotId);
  for (const issue of owned) {
    try {
      const out = gh
        .run(['issue', 'view', String(issue), '--json', 'state,labels', '-q', '.state + " " + (.labels|map(.name)|join(","))'])
        .trim();
      const spaceIdx = out.indexOf(' ');
      const state = spaceIdx === -1 ? out : out.slice(0, spaceIdx);
      const labels = spaceIdx === -1 ? '' : out.slice(spaceIdx + 1);
      if (state === 'OPEN' && ` ${labels.split(',').join(' ')} `.includes(' in-progress ')) {
        return String(issue);
      }
    } catch {
      continue;
    }
  }
  return '';
}

export function cleanupStateDir(baseDir: string, gh: GhAdapter, now: number, claims: ClaimAdapter, slotId: string): string[] {
  const keep = runningIssue(gh, claims, slotId);
  // #387 AC7: ein laufendes Ticket kann jetzt auch ein Denk-Lauf sein --
  // dessen Session liegt unter 'session-think-<nr>', nicht 'session-<nr>'
  // (#356). Beide Familien schonen, sonst verliert ein per Limit >7 Tage
  // pausierter Planer-Lauf seine Denk-Session (dieselbe Fehlerklasse wie
  // Korrektur 5 fuer Bau-Sessions).
  const keepFiles = keep ? [`session-${keep}`, `session-think-${keep}`] : [];
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return removed;
  }

  for (const name of entries) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    if (keepFiles.includes(name)) continue;

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
