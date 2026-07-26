// Eine Wache statt zwei, portiert aus claude-runner.sh (#202, S5 von #184).
// Bisher standen die CI-Wache fuer ein laufendes Bau-Ticket (#147/#160/#171)
// und die CI-Wache fuer ALLE geparkten Tickets (#154/#173) als getrennte
// Bash-Bloecke nebeneinander -- zwei Automaten, die denselben `PrState` (S4)
// unterschiedlich, aber je fuer sich auswerteten. `watchReaction()` ist die
// EINE Uebergangstabelle: `parked` ist ein Eingabefeld, kein eigener Zweig.
// Beide Wachen unten (`watchRunningIssue`/`watchParkedIssues`) loesen den
// PR-Zustand zuerst zu einem `WatchState` auf (`resolveWatchState`) und
// lassen DANACH `watchReaction()` entscheiden -- keine der beiden hat eine
// eigene, parallele Fallunterscheidung.
//
// Absichtliche Verhaltens-Unterschiede zwischen geparkt/laufend (aus der
// bestehenden Bash-Logik uebernommen, NICHT neu erfunden):
//   - 'behind-retry' (transiente Nachzieh-Fehler: unsauberer Baum, fetch/
//     checkout/push gescheitert) eskaliert NUR fuer laufende Tickets nach drei
//     Runden auf Gelb (`catchupFailEscalated`, S4) -- ein geparktes Ticket
//     bleibt dabei stumm geparkt, ohne eigene Eskalationszaehlung. Das ist
//     keine neue Einschraenkung dieser Stufe, sondern der Status quo aus #173.
//   - 'failing-protected' (nur `protected-paths` rot) bleibt fuer BEIDE eine
//     stille Genehmigungs-Schranke -- laufend setzt zusaetzlich `needs-input`
//     (die Schranke selbst), geparkt hat das idR schon gesetzt, bleibt also
//     unangetastet.
//
// Die menschenlesbaren Statustexte (status()-Aufrufe) bleiben bewusst in
// claude-runner.sh -- dort werden sie von den bestehenden Bash-Fixtures
// (ci-watch.test.sh, parked-ci-watch.test.sh) 1:1 auf Wortlaut geprueft.
// Diese Funktionen liefern nur die ENTSCHEIDUNG plus die Daten, die in die
// (unveraenderten) Textbausteine eingesetzt werden.
import type { GhAdapter } from './gh.js';
import type { GitAdapter } from './git.js';
import type { StateAdapter } from './state.js';
import { prCiState, prFailureSummary, prForIssue, prOnlyProtectedPathsRed, prSquashMerge } from './pr.js';
import { catchupFailEscalated, catchupFailReason, catchupFailReset, prCatchUpBehind } from './catchup.js';

export type WatchState =
  | 'pending'
  | 'success'
  | 'failing-protected'
  | 'failing-fix'
  | 'behind-caught-up'
  | 'behind-conflict'
  | 'behind-retry'
  | 'dirty-conflict';

export interface WatchReactionInput {
  state: WatchState;
  parked: boolean;
  // Nur relevant fuer state === 'behind-retry' && !parked (S. Kommentar oben).
  retryEscalated?: boolean;
}

export type WatchReaction =
  | { kind: 'noop' }
  | { kind: 'wait'; severity: 'green' | 'yellow' }
  | { kind: 'add-needs-input' }
  | { kind: 'merge' }
  | { kind: 'promote-candidate' }
  | { kind: 'build-fix' };

// Die Uebergangstabelle (AC1/AC2): EINE Funktion fuer geparkte UND laufende
// Tickets. Jeder `WatchState` hat fuer `parked: true` UND `parked: false`
// eine definierte Reaktion -- keine Luecke, siehe watch.test.ts.
export function watchReaction(input: WatchReactionInput): WatchReaction {
  const { state, parked } = input;
  switch (state) {
    case 'pending':
      return parked ? { kind: 'noop' } : { kind: 'wait', severity: 'green' };
    case 'success':
      return { kind: 'merge' };
    case 'failing-protected':
      return parked ? { kind: 'noop' } : { kind: 'add-needs-input' };
    case 'failing-fix':
      return parked ? { kind: 'promote-candidate' } : { kind: 'build-fix' };
    case 'behind-caught-up':
      return parked ? { kind: 'noop' } : { kind: 'wait', severity: 'green' };
    case 'behind-conflict':
      return parked ? { kind: 'promote-candidate' } : { kind: 'build-fix' };
    // #217: identische Reaktion wie 'behind-conflict' -- der Unterschied liegt
    // allein darin, WIE der Konflikt festgestellt wurde (GitHubs DIRTY statt
    // eines gescheiterten lokalen Merges) und im Wortlaut der Begruendung.
    case 'dirty-conflict':
      return parked ? { kind: 'promote-candidate' } : { kind: 'build-fix' };
    case 'behind-retry':
      if (parked) return { kind: 'noop' };
      return { kind: 'wait', severity: input.retryEscalated ? 'yellow' : 'green' };
    default: {
      const exhaustive: never = state;
      throw new Error(`unbekannter WatchState: ${exhaustive}`);
    }
  }
}

// Textbaustein fuer den CI-Fix-Auftrag bei einem echten Merge-Konflikt beim
// Nachziehen -- 1:1 aus der bisherigen Bash-Vorlage (CI_SUMMARY-Zweig
// 'behind'/rc=1: `Betroffene Dateien: ${CATCHUP_OUT:-unbekannt}`, wobei
// CATCHUP_OUT kommagetrennt OHNE Leerzeichen ist, siehe catchupStdout()),
// nur parametrisiert statt inline.
export function conflictSummary(issue: number, pr: string, files: string[]): string {
  const fileList = files.length > 0 ? files.join(',') : 'unbekannt';
  return `### Merge-Konflikt beim Nachziehen von \`main\`
PR #${pr} (#${issue}) liegt hinter \`main\`. Das automatische Nachziehen (\`git fetch\` +
\`git merge origin/main\`) ist an einem echten Konflikt gescheitert.

Betroffene Dateien: ${fileList}

Löse den Konflikt auf dem bestehenden Branch: \`git fetch origin main\`,
\`git merge origin/main\`, die genannten Dateien bereinigen, committen, pushen.`;
}

// Textbaustein fuer den Fix-Auftrag bei einem von GitHub gemeldeten Konflikt
// (mergeStateStatus DIRTY, #217). Eigener Wortlaut statt conflictSummary():
// hier ist der Konflikt nicht beim Nachziehen ENTSTANDEN, er stand schon
// vorher fest -- der lokale Merge diente nur dazu, die Dateien zu benennen.
export function dirtySummary(issue: number, pr: string, files: string[], probeFailReason?: string): string {
  const fileList = probeFailReason
    ? `unbekannt (lokale Ermittlung ist an \`${probeFailReason}\` gescheitert)`
    : files.length > 0
      ? files.join(',')
      : 'unbekannt';
  return `### Merge-Konflikt (DIRTY) mit \`main\`
PR #${pr} (#${issue}) ist laut GitHub konfliktbehaftet (\`mergeStateStatus: DIRTY\`).

Betroffene Dateien: ${fileList}

Löse den Konflikt auf dem bestehenden Branch: \`git fetch origin main\`,
\`git merge origin/main\`, die genannten Dateien bereinigen, committen, pushen.`;
}

interface WatchDeps {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
}

interface ResolvedWatchState {
  state: WatchState;
  conflictFiles?: string[];
  // Nur fuer 'dirty-conflict': die lokale Ermittlung der Konfliktdateien ist
  // an Infrastruktur gescheitert (nicht am Konflikt selbst) -- der Grund wird
  // im Auftrag genannt, statt eine leere Dateiliste zu behaupten (#217 AC2).
  conflictProbeFailReason?: string;
  retryReason?: string;
  retryPaths?: string[];
  retryEscalated?: boolean;
  failSummary?: string;
}

// Loest den rohen `PrState` (S4) zu einem `WatchState` auf -- inklusive der
// dafuer noetigen Seiteneffekte (Nachziehen per git, Fehlversuchs-Zaehler
// zuruecksetzen/hochzaehlen, Zusammenfassung roter Checks holen). Identisch
// fuer geparkt und laufend; NUR die anschliessende `watchReaction()` wertet
// `parked` unterschiedlich.
function resolveWatchState(issue: number, pr: string, parked: boolean, deps: WatchDeps): ResolvedWatchState {
  const ciState = prCiState(pr, deps.gh);

  if (ciState === 'pending') return { state: 'pending' };
  if (ciState === 'success') return { state: 'success' };

  if (ciState === 'failing') {
    if (prOnlyProtectedPathsRed(pr, deps.gh)) return { state: 'failing-protected' };
    return { state: 'failing-fix', failSummary: prFailureSummary(pr, deps.gh) };
  }

  // ciState === 'conflict' (#217): DIRTY ist bereits GitHubs eigene,
  // authoritative Aussage -- anders als bei 'behind' braucht es keinen lokalen
  // Merge-Versuch, um zu WISSEN, dass hier Konfliktarbeit ansteht. Der lokale
  // Versuch dient nur dazu, die betroffenen Dateien fuer den Auftrag zu
  // benennen. Deshalb wird bei Infrastruktur-Fehlschlaegen NICHT stillschweigend
  // gewartet wie bei 'behind' -- ein DIRTY-PR loest sich nie von selbst durch
  // Zeitablauf, der Fix-Agent startet trotzdem (AC2).
  if (ciState === 'conflict') {
    const probe = prCatchUpBehind(pr, deps.git, deps.gh);
    catchupFailReset(issue, deps.state);
    if (probe.kind === 'ok') return { state: 'behind-caught-up' };
    if (probe.kind === 'conflict') return { state: 'dirty-conflict', conflictFiles: probe.files };
    const probeCode = { dirty: 2, fetchFailed: 3, checkoutFailed: 4, pushFailed: 5 } as const;
    return { state: 'dirty-conflict', conflictProbeFailReason: catchupFailReason(probeCode[probe.kind]) };
  }

  // ciState === 'behind'
  const result = prCatchUpBehind(pr, deps.git, deps.gh);
  if (result.kind === 'ok') {
    catchupFailReset(issue, deps.state);
    return { state: 'behind-caught-up' };
  }
  if (result.kind === 'conflict') {
    catchupFailReset(issue, deps.state);
    return { state: 'behind-conflict', conflictFiles: result.files };
  }
  const codeByKind = { dirty: 2, fetchFailed: 3, checkoutFailed: 4, pushFailed: 5 } as const;
  const reason = catchupFailReason(codeByKind[result.kind]);
  // Eskalationszaehlung (drei Runden in Folge dieselbe Ursache) ist nur fuer
  // LAUFENDE Tickets relevant (siehe Modulkommentar) -- fuer geparkte wird
  // sie erst gar nicht gefuehrt, damit ihr Zaehler nicht durch parallele
  // Pruefungen desselben Tickets verzerrt wird.
  const escalated = parked ? false : catchupFailEscalated(issue, reason, deps.state);
  // Stoerende Pfade werden nur bei unsauberem Arbeitsbaum (#171 AC1) genannt,
  // nicht bei fetch/checkout/push-Fehlschlaegen.
  const retryPaths = result.kind === 'dirty' ? result.paths : undefined;
  return { state: 'behind-retry', retryReason: reason, retryPaths, retryEscalated: escalated };
}

export type RunningWatchResult =
  | { kind: 'pending' }
  | { kind: 'merged' }
  | { kind: 'needs-input-protected' }
  | { kind: 'build-fix'; summary: string }
  | { kind: 'caught-up' }
  | { kind: 'retry'; reason: string; paths: string[]; escalated: boolean };

// CI-Wache fuer EIN laufendes Bau-Ticket (#147/#160/#171), jetzt ueber die
// gemeinsame Uebergangstabelle. `issue`/`pr` sind bereits bekannt (Aufrufer
// hat pr_for_issue() schon ausgewertet).
export function watchRunningIssue(issue: number, pr: string, deps: WatchDeps): RunningWatchResult {
  const resolved = resolveWatchState(issue, pr, false, deps);
  const reaction = watchReaction({ state: resolved.state, parked: false, retryEscalated: resolved.retryEscalated });

  switch (reaction.kind) {
    case 'wait':
      if (resolved.state === 'behind-caught-up') return { kind: 'caught-up' };
      if (resolved.state === 'behind-retry') {
        return {
          kind: 'retry',
          reason: resolved.retryReason ?? '',
          paths: resolved.retryPaths ?? [],
          escalated: reaction.severity === 'yellow',
        };
      }
      return { kind: 'pending' };
    case 'add-needs-input':
      deps.gh.run(['issue', 'edit', String(issue), '--add-label', 'needs-input']);
      return { kind: 'needs-input-protected' };
    case 'merge':
      deps.gh.run(['pr', 'ready', pr]);
      prSquashMerge(pr, deps.gh);
      return { kind: 'merged' };
    case 'build-fix':
      if (resolved.state === 'behind-conflict') {
        return { kind: 'build-fix', summary: conflictSummary(issue, pr, resolved.conflictFiles ?? []) };
      }
      if (resolved.state === 'dirty-conflict') {
        return {
          kind: 'build-fix',
          summary: dirtySummary(issue, pr, resolved.conflictFiles ?? [], resolved.conflictProbeFailReason),
        };
      }
      return { kind: 'build-fix', summary: resolved.failSummary ?? '' };
    case 'noop':
      /* istanbul ignore next -- 'noop' kommt fuer parked:false nie zurueck */
      return { kind: 'pending' };
    case 'promote-candidate':
      /* istanbul ignore next -- nur bei parked:true moeglich, siehe watchParkedIssues() */
      throw new Error('unerwartete promote-candidate Reaktion fuer ein laufendes Ticket');
  }
}

export interface ParkedIssueInput {
  number: number;
  createdAt: string;
  hasNeedsInput: boolean;
}

export interface ParkedWatchOutcome {
  // Hoechstens EIN Ticket wird pro Runde entparkt (#154 AC "höchstens EIN").
  promoted: { issue: number; reason: string } | null;
  released: number[];
}

const PROMOTE_REASON: Record<'behind-conflict' | 'dirty-conflict' | 'failing-fix', string> = {
  'behind-conflict': 'ein Merge-Konflikt beim Nachziehen von `main`',
  'dirty-conflict': 'ein Merge-Konflikt (`DIRTY`) mit `main`',
  'failing-fix': 'rote Checks (mehr als nur `protected-paths`)',
};

// CI-Wache fuer ALLE geparkten Tickets (#154, erweitert um #173) -- ueber
// dieselbe Uebergangstabelle wie watchRunningIssue(), mit `parked: true`.
// `wipSlotFree` = kein anderes Ticket war beim Rundenstart in-progress
// (WIP-Limit=1, CLAUDE.md Regel 1); wird waehrend des Loops NICHT neu
// bewertet, exakt wie in der bisherigen Bash-Implementierung (nur EIN
// entparktes Ticket pro Runde, unabhaengig davon, wie viele Kandidaten es gibt).
export function watchParkedIssues(parkedIssues: ParkedIssueInput[], wipSlotFree: boolean, deps: WatchDeps): ParkedWatchOutcome {
  const sorted = [...parkedIssues].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const outcome: ParkedWatchOutcome = { promoted: null, released: [] };

  for (const issue of sorted) {
    const pr = prForIssue(issue.number, deps.gh);
    if (!pr) continue;

    const resolved = resolveWatchState(issue.number, pr, true, deps);
    const reaction = watchReaction({ state: resolved.state, parked: true });

    if (reaction.kind === 'merge') {
      deps.gh.run(['pr', 'ready', pr]);
      // #217 AC4: 'parked'/'needs-input' duerfen nur weg, wenn der Merge bzw.
      // das Aktivieren von Auto-Merge tatsaechlich geklappt hat -- sonst faellt
      // das Ticket aus jeder Wache heraus, waehrend der PR offen und
      // unbeobachtet liegen bleibt. Schlaegt es fehl, bleibt das Ticket
      // geparkt, der naechste Takt versucht es erneut.
      if (!prSquashMerge(pr, deps.gh)) continue;
      deps.gh.run([
        'issue',
        'edit',
        String(issue.number),
        '--remove-label',
        'parked',
        '--remove-label',
        'needs-input',
        '--remove-label',
        'needs-answer',
      ]);
      outcome.released.push(issue.number);
      continue;
    }

    if (reaction.kind === 'promote-candidate') {
      const canPromote = !issue.hasNeedsInput && outcome.promoted === null && wipSlotFree;
      if (canPromote) {
        deps.gh.run(['issue', 'edit', String(issue.number), '--remove-label', 'parked', '--add-label', 'in-progress']);
        const reasonKey =
          resolved.state === 'behind-conflict' || resolved.state === 'dirty-conflict' ? resolved.state : 'failing-fix';
        outcome.promoted = { issue: issue.number, reason: PROMOTE_REASON[reasonKey] };
      }
      // Nicht promotable (Slot belegt/schon eins entparkt/needs-input haengt
      // noch): bleibt geparkt, still -- wie 'noop'.
      continue;
    }

    // 'noop'/'wait'/'add-needs-input' kommen fuer geparkte Tickets nur in
    // stillen Faellen zurueck (pending, behind-caught-up, behind-retry,
    // failing-protected) -- nichts zu tun, naechster Takt prueft erneut.
  }

  return outcome;
}
