// Ticket-Anspruch bei mehreren Slots (#204): atomarer Claim unter
// SHARED_DIR/claims/<issue>/, per `rename` mit Besitzer-Inhalt angelegt
// (ADR-0020, #449) -- ersetzt damit ein fehlendes Compare-and-Swap bei
// GitHub-Labels (ein reines Label-Rennen waere nicht sicher).
//
// Ein Claim verfaellt am LABEL (in-progress), NIE an einer PID: der
// Runner-Prozess stirbt planmaessig nach jedem Tick, ein in-progress-Ticket
// ueberlebt viele Ticks (wartet z. B. 20 Minuten auf CI). PID-Liveness wuerde
// jeden Claim nach wenigen Minuten freigeben -- genau der Schaden, den dieses
// Ticket verhindern soll.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GhAdapter } from './gh.js';
import type { QueueIssue } from './queue.js';

export interface ClaimAdapter {
  /**
   * true = Claim wurde HIER atomar mit `slotId` als Besitzer angelegt (frisch
   * oder ein leeres Altverzeichnis ersetzt). false = Zielverzeichnis war
   * bereits nicht-leer -- ein anderer Slot haelt den Claim (oder haelt ihn
   * noch, Fortsetzung).
   */
  claimAtomic(issue: number, slotId: string): boolean;
  /** null = kein Claim vorhanden. '' = Claim da, slot-Datei leer/fehlt (frei). */
  readSlot(issue: number): string | null;
  /** Alter seit Anlage in ms, null wenn kein Claim existiert. */
  ageMs(issue: number, now: number): number | null;
  list(): number[];
  release(issue: number): void;
  /** Raeumt `.tmp-*`-Reste eines zwischen Anlage und `rename` abgebrochenen `claimAtomic` weg. */
  sweepTmp(olderThanMs: number, now: number): void;
}

export function createClaimAdapter(baseDir: string): ClaimAdapter {
  const dirOf = (issue: number) => join(baseDir, String(issue));
  const slotFile = (issue: number) => join(dirOf(issue), 'slot');
  const tmpDirOf = () => join(baseDir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);

  return {
    claimAtomic(issue, slotId) {
      mkdirSync(baseDir, { recursive: true });
      const tmp = tmpDirOf();
      mkdirSync(tmp);
      writeFileSync(join(tmp, 'slot'), slotId, 'utf-8');
      try {
        // `rename` auf ein nicht-leeres Zielverzeichnis scheitert atomar
        // (POSIX ENOTEMPTY) -- genau ein Gewinner, nie ein leerer
        // Zwischenzustand wie beim frueheren mkdir+writeFile (ADR-0020).
        renameSync(tmp, dirOf(issue));
        return true;
      } catch {
        rmSync(tmp, { recursive: true, force: true });
        return false;
      }
    },
    readSlot(issue) {
      if (!existsSync(dirOf(issue))) return null;
      try {
        return readFileSync(slotFile(issue), 'utf-8').trim();
      } catch {
        // Verzeichnis da, slot-Datei (noch) nicht -- Zwischenzustand eines
        // abgebrochenen Laufs (siehe claimAtomic), zaehlt als frei.
        return '';
      }
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
    sweepTmp(olderThanMs, now) {
      let names: string[];
      try {
        names = readdirSync(baseDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.startsWith('.tmp-')) continue;
        const path = join(baseDir, name);
        try {
          if (now - statSync(path).mtimeMs >= olderThanMs) rmSync(path, { recursive: true, force: true });
        } catch {
          // zwischen readdir und stat verschwunden -- kein Problem.
        }
      }
    },
  };
}

// Die Notbremse killt jeden Lauf spaetestens nach MAX_RUNTIME
// (scripts/claude-runner.sh, Default 2700 s = 45 min). Die Schonfrist liegt
// bewusst DARUEBER (abgeleitet, nicht frei gewaehlt), damit ein noch laufender
// Bau prinzipiell nie in den Sweep geraet -- auch am oberen Ende seiner
// Laufzeit, wenn er sein 'in-progress' noch nicht gesetzt hat (#482).
const MAX_RUNTIME_MS = 45 * 60 * 1000;
export const SWEEP_GRACE_MS = MAX_RUNTIME_MS + 5 * 60 * 1000; // 50 min

// `.tmp-*`-Reste eines abgebrochenen `claimAtomic` sind eine andere Concern
// als die Schonfrist fuer laufende Builds -- eigene Konstante, damit das
// Anheben von SWEEP_GRACE_MS (#482) das bisherige Raeum-Timing nicht anfasst.
const TMP_STALE_MS = 10 * 60 * 1000;

/**
 * Beansprucht `issue` fuer `slotId`. true = das Ticket gehoert jetzt diesem
 * Slot -- entweder weil der Claim atomar neu angelegt wurde (frisch oder ein
 * leeres/verwaistes Altverzeichnis ersetzt, ADR-0020), oder weil er schon
 * diesem Slot gehoerte (Fortsetzung). Ein voller Claim eines ANDEREN Slots
 * laesst `claimAtomic` scheitern -- dann false, kein Fortsetzungsversuch.
 */
export function claimTake(claims: ClaimAdapter, issue: number, slotId: string): boolean {
  if (claims.claimAtomic(issue, slotId)) return true;
  return claims.readSlot(issue) === slotId;
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

/**
 * Issue-Nummern, die ein ANDERER Slot beansprucht -- fuer die Auswahl-Kaskade
 * in select.ts, die den vollen Snapshot fuer die Abhaengigkeits-Aufloesung
 * braucht (queueBlocked prueft, ob ein Blocker noch offen ist). `claimFilter()`
 * allein wuerde ein von einem anderen Slot beanspruchtes Ticket komplett aus
 * dem Snapshot werfen -- ein davon abhaengiges Ticket saehe seinen Blocker
 * dann faelschlich als "nicht mehr offen" und wuerde verfrueht freigegeben,
 * waehrend der andere Slot noch daran baut. Diese Funktion liefert nur die
 * Menge zum ZUSAETZLICHEN Ausschluss aus der Auswahl, laesst den Snapshot
 * selbst (und damit die Abhaengigkeitspruefung) unangetastet.
 */
export function claimedElsewhere(claims: ClaimAdapter, slotId: string): Set<number> {
  const result = new Set<number>();
  for (const issue of claims.list()) {
    const owner = claims.readSlot(issue);
    if (owner !== null && owner !== '' && owner !== slotId) result.add(issue);
  }
  return result;
}

// #326: 'in-progress' allein reicht nicht -- pickTicket() setzt es nur fuer
// die Bau-Rolle. Ein Plan- oder Recherche-Lauf traegt stattdessen weiterhin
// 'plan'/'research', bis er selbst fertig ist und das Label wegflippt. Ohne
// diese beiden zusaetzlich als "noch aktiv" zu werten, hielt der Claim eines
// laufenden Plan-Laufs nur die Schonfrist (SWEEP_GRACE_MS) durch -- danach
// riss der Sweep ihn weg, obwohl der Lauf noch arbeitete, und ein zweiter Slot
// konnte dieselbe Rolle fuer dasselbe Ticket ein zweites Mal starten (Anlass:
// #216 legte am 28.07.26 seine drei Bau-Tickets doppelt an).
// #839: 'check' gehoert aus demselben Grund dazu. Der Normalweg dorthin
// behaelt zwar 'in-progress' und traegt den Claim ohnehin -- aber ein Ticket,
// das nur noch 'check' traegt, wartet auf sein Merge-Tor und ist damit
// laufende Arbeit, nicht herrenlos.
const ACTIVE_ROLE_LABELS = ['in-progress', 'plan', 'research', 'check'];

const GH_FAILED = 'gh-failed';

interface IssueState {
  state: string;
  labels: string[];
}

function issueState(issue: number, gh: GhAdapter): IssueState | typeof GH_FAILED {
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
    const labels = spaceIdx === -1 ? [] : out.slice(spaceIdx + 1).split(',');
    return { state, labels };
  } catch {
    // gh scheitert (Netz, Rate-Limit, geloeschtes Ticket): NICHT freigeben (#482).
    // Ein Fehlschlag ist kein Beweis, dass das Ticket erledigt ist -- ein noch
    // laufender Besitzer hat seinen Claim schon und nimmt ihn nicht erneut, ein
    // anderer Slot wuerde ihn stattdessen fortsetzen (round.ts). Nur ein positiv
    // bestaetigtes "geschlossen oder ohne Rollen-Label" (der try-Pfad) gibt frei.
    return GH_FAILED;
  }
}

/**
 * NUR vom Leitslot, einmal pro Runde: raeumt verwaiste Claims weg. Ein
 * Ticket ohne `in-progress` (gemergt, geschlossen, vom Menschen
 * zurueckgesetzt) gibt seinen Platz von selbst frei -- auch nach einem
 * Stromausfall, ohne dass ein Mensch eingreifen muss. Ein Claim, dessen
 * Ticket beim Freigeben bereits CLOSED ist, traegt oft noch `in-progress`
 * (#498: GitHub schliesst beim Auto-Merge, ohne dass Runner-Code laeuft, der
 * es abnaehme) -- der Sweep nimmt es hier best-effort mit ab.
 */
export function claimSweep(claims: ClaimAdapter, gh: GhAdapter, now: number): void {
  claims.sweepTmp(TMP_STALE_MS, now);
  for (const issue of claims.list()) {
    const age = claims.ageMs(issue, now);
    if (age === null || age < SWEEP_GRACE_MS) continue;
    const info = issueState(issue, gh);
    if (info === GH_FAILED) continue; // #482: kein Beweis fuer "erledigt" -- Claim behalten.
    if (info.state === 'OPEN' && info.labels.some((label) => ACTIVE_ROLE_LABELS.includes(label))) continue;
    // Nur bei bestaetigt CLOSED abnehmen -- niemals bei OPEN (auch nicht ohne
    // Rollen-Label): ein offenes Ticket sein `in-progress` zu nehmen, gaebe es
    // der Flotte weg, obwohl es niemand geloest hat.
    if (info.state === 'CLOSED' && info.labels.includes('in-progress')) {
      try {
        gh.run(['issue', 'edit', String(issue), '--remove-label', 'in-progress']);
      } catch {
        /* best-effort -- ein Fehlschlag bricht den Sweep nicht ab */
      }
    }
    claimRelease(claims, issue);
  }
}
