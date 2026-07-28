// Ticket-Anspruch bei mehreren Slots (#204): atomarer `mkdir`-Claim unter
// SHARED_DIR/claims/<issue>/, dieselbe Technik wie der bestehende Lauf-Lock in
// claude-runner.sh -- `mkdir` ist atomar auf POSIX und ersetzt damit ein
// fehlendes Compare-and-Swap bei GitHub-Labels (ein reines Label-Rennen waere
// nicht sicher).
//
// Ein Claim verfaellt am LABEL (in-progress), NIE an einer PID: der
// Runner-Prozess stirbt planmaessig nach jedem Tick, ein in-progress-Ticket
// ueberlebt viele Ticks (wartet z. B. 20 Minuten auf CI). PID-Liveness wuerde
// jeden Claim nach wenigen Minuten freigeben -- genau der Schaden, den dieses
// Ticket verhindern soll.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GhAdapter } from './gh.js';
import type { QueueIssue } from './queue.js';

export interface ClaimAdapter {
  /** true = Verzeichnis wurde HIER neu angelegt (mkdir atomar gewonnen). */
  take(issue: number): boolean;
  /** null = kein Claim vorhanden. '' = Claim da, slot-Datei leer/fehlt (frei). */
  readSlot(issue: number): string | null;
  writeSlot(issue: number, slotId: string): void;
  /** Alter seit Anlage in ms, null wenn kein Claim existiert. */
  ageMs(issue: number, now: number): number | null;
  list(): number[];
  release(issue: number): void;
}

export function createClaimAdapter(baseDir: string): ClaimAdapter {
  const dirOf = (issue: number) => join(baseDir, String(issue));
  const slotFile = (issue: number) => join(dirOf(issue), 'slot');

  return {
    take(issue) {
      mkdirSync(baseDir, { recursive: true });
      try {
        mkdirSync(dirOf(issue));
        return true;
      } catch {
        return false;
      }
    },
    readSlot(issue) {
      if (!existsSync(dirOf(issue))) return null;
      try {
        return readFileSync(slotFile(issue), 'utf-8').trim();
      } catch {
        // Verzeichnis da, slot-Datei (noch) nicht -- der Zwischenzustand aus
        // Korrektur 7: zaehlt als frei, nicht als fremd.
        return '';
      }
    },
    writeSlot(issue, slotId) {
      mkdirSync(dirOf(issue), { recursive: true });
      writeFileSync(slotFile(issue), slotId, 'utf-8');
    },
    ageMs(issue, now) {
      try {
        return now - statSync(dirOf(issue)).mtimeMs;
      } catch {
        return null;
      }
    },
    list() {
      try {
        return readdirSync(baseDir)
          .map((name) => Number(name))
          .filter((n) => Number.isInteger(n) && n > 0);
      } catch {
        return [];
      }
    },
    release(issue) {
      rmSync(dirOf(issue), { recursive: true, force: true });
    },
  };
}

// Korrektur 6: ein Claim unter 10 Minuten wird vom Sweep NIE angefasst.
// Zwischen `claimTake()` und dem Setzen von `in-progress` liegen mehrere
// `gh`-Aufrufe -- tickt der Leitslot in genau diesem Fenster, saehe er einen
// Claim ohne 'in-progress' und raeumte ihn faelschlich weg.
const SWEEP_GRACE_MS = 10 * 60 * 1000;

/**
 * Beansprucht `issue` fuer `slotId`. true = das Ticket gehoert jetzt diesem
 * Slot -- entweder weil der Claim hier neu angelegt wurde, weil er schon
 * diesem Slot gehoerte (Fortsetzung), oder weil er verwaist war (Korrektur 7:
 * eine leere/fehlende slot-Datei gilt als FREI, nicht als fremd -- sonst
 * blockiert ein zwischen `mkdir` und dem Schreiben abgebrochener Claim das
 * Ticket fuer immer, ohne dass irgendwo etwas rot wird).
 */
export function claimTake(claims: ClaimAdapter, issue: number, slotId: string): boolean {
  if (claims.take(issue)) {
    claims.writeSlot(issue, slotId);
    return true;
  }
  const owner = claims.readSlot(issue);
  if (owner === null || owner === '') {
    claims.writeSlot(issue, slotId);
    return true;
  }
  return owner === slotId;
}

/**
 * Wirft aus `snapshot` alle Tickets raus, deren Claim einem ANDEREN Slot
 * gehoert -- fuer diesen Slot existieren sie danach schlicht nicht. EIN
 * Filter direkt nach dem Schnappschuss statt sechs einzelne Umbauten in den
 * Auswahlstellen (siehe round.ts/select.ts): die bleiben unangetastet.
 */
export function claimFilter(snapshot: QueueIssue[], claims: ClaimAdapter, slotId: string): QueueIssue[] {
  return snapshot.filter((issue) => {
    const owner = claims.readSlot(issue.number);
    return owner === null || owner === '' || owner === slotId;
  });
}

/** Entspricht `rm -rf` -- ein fehlender Claim ist kein Fehler. */
export function claimRelease(claims: ClaimAdapter, issue: number): void {
  claims.release(issue);
}

function isStillClaimable(issue: number, gh: GhAdapter): boolean {
  try {
    const out = gh.run([
      'issue',
      'view',
      String(issue),
      '--json',
      'state,labels',
      '-q',
      '.state + " " + (.labels|map(.name)|join(","))',
    ]);
    const spaceIdx = out.indexOf(' ');
    const state = spaceIdx === -1 ? out : out.slice(0, spaceIdx);
    const labels = spaceIdx === -1 ? '' : out.slice(spaceIdx + 1).split(',');
    return state === 'OPEN' && labels.includes('in-progress');
  } catch {
    // gh scheitert (Netz, geloeschtes Ticket) -- best effort wie ueberall
    // sonst im Runner: lieber ein zu frueh freigegebener Claim (der naechste
    // Take gewinnt ihn zurueck) als ein haengender Sweep.
    return false;
  }
}

/**
 * NUR vom Leitslot, einmal pro Runde: raeumt verwaiste Claims weg. Ein
 * Ticket ohne `in-progress` (gemergt, geschlossen, vom Menschen
 * zurueckgesetzt) gibt seinen Platz von selbst frei -- auch nach einem
 * Stromausfall, ohne dass ein Mensch eingreifen muss.
 */
export function claimSweep(claims: ClaimAdapter, gh: GhAdapter, now: number): void {
  for (const issue of claims.list()) {
    const age = claims.ageMs(issue, now);
    if (age === null || age < SWEEP_GRACE_MS) continue;
    if (isStillClaimable(issue, gh)) continue;
    claimRelease(claims, issue);
  }
}
