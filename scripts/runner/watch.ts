// Eine Wache statt zwei, portiert aus claude-runner.sh (#202, S5 von #184).
// Bisher standen die CI-Wache fuer ein laufendes Bau-Ticket (#147/#160/#171)
// und die CI-Wache fuer ALLE geparkten Tickets (#154/#173) als getrennte
// Bash-Bloecke nebeneinander -- zwei Automaten, die denselben `PrState` (S4)
// unterschiedlich, aber je fuer sich auswerteten. `watchReaction()` ist die
// EINE Uebergangstabelle: `waiting` ist ein Eingabefeld, kein eigener Zweig.
// Beide Wachen unten (`watchRunningIssue`/`watchWaitingIssues`) loesen den
// PR-Zustand zuerst zu einem `WatchState` auf (`resolveWatchState`) und
// lassen DANACH `watchReaction()` entscheiden -- keine der beiden hat eine
// eigene, parallele Fallunterscheidung.
//
// Absichtliche Verhaltens-Unterschiede zwischen wartend/laufend (aus der
// bestehenden Bash-Logik uebernommen, NICHT neu erfunden):
//   - 'behind-retry' (transiente Nachzieh-Fehler: unsauberer Baum, fetch/
//     checkout/push gescheitert) eskaliert NUR fuer laufende Tickets nach drei
//     Runden auf Gelb (`catchupFailEscalated`, S4) -- ein wartendes Ticket
//     bleibt dabei still, ohne eigene Eskalationszaehlung. Das ist
//     keine neue Einschraenkung dieser Stufe, sondern der Status quo aus #173.
//
// #283: Der Zustand 'failing-protected' (nur `protected-paths` rot) ist
// ersatzlos entfallen. Mit #276 blockierte der Waechter nicht mehr, mit #283
// ist der Job selbst weg -- einen Check, den es nicht gibt, kann kein PR
// reissen. Bis dahin stand hier ein Zweig, der nur noch Lesezeit kostete.
//
// Die menschenlesbaren Statustexte (status()-Aufrufe) bleiben bewusst in
// claude-runner.sh -- dort werden sie von den bestehenden Bash-Fixtures
// (ci-watch.test.sh, waiting-ci-watch.test.sh) 1:1 auf Wortlaut geprueft.
// Diese Funktionen liefern nur die ENTSCHEIDUNG plus die Daten, die in die
// (unveraenderten) Textbausteine eingesetzt werden.
import type { Clock } from './clock.js';
import type { GhAdapter } from './gh.js';
import type { GitAdapter } from './git.js';
import type { StateAdapter } from './state.js';
import { prCiState, prFailureSummary, prForIssue, prSquashMerge } from './pr.js';
import { catchupFailEscalated, catchupFailReason, catchupFailReset, prCatchUpBehind } from './catchup.js';

// #324: ab dieser Schwelle (Minuten) gilt ein 'pending' als haengen geblieben
// statt als normal laufende CI -- Startwert lt. Ticket, benannte Konstante
// statt Magic Number im Vergleich unten.
export const PENDING_STALL_MINUTES = 45;

export type WatchState =
  | 'pending'
  | 'success'
  | 'failing-fix'
  | 'behind-caught-up'
  | 'behind-conflict'
  | 'behind-retry'
  | 'dirty-conflict';

export interface WatchReactionInput {
  state: WatchState;
  // #272: hiess bis S2b `parked`. Ein wartendes Ticket behaelt jetzt
  // 'in-progress' und traegt zusaetzlich 'needs-answer' -- der Zustand ist
  // derselbe, nur ohne Label-Umschreibung.
  waiting: boolean;
  // Nur relevant fuer state === 'behind-retry' && !waiting (S. Kommentar oben).
  retryEscalated?: boolean;
  // #324: nur relevant fuer state === 'pending' && !waiting -- ein wartendes
  // Ticket bleibt bei 'pending' ohnehin still (siehe watchReaction unten).
  pendingEscalated?: boolean;
}

export type WatchReaction =
  | { kind: 'noop' }
  | { kind: 'wait'; severity: 'green' | 'yellow' }
  | { kind: 'merge' }
  | { kind: 'build-fix' };

// Die Uebergangstabelle (AC1/AC2): EINE Funktion fuer wartende UND laufende
// Tickets. Jeder `WatchState` hat fuer beide Faelle eine definierte Reaktion --
// keine Luecke, siehe watch.test.ts.
//
// #272: fuer ein wartendes Ticket gibt es nur noch zwei Ausgaenge. Wird sein PR
// gruen, wird gemerged (dann ist die Frage gegenstandslos); sonst passiert
// nichts. Die frueher hier stehende 'promote-candidate'-Reaktion ist ersatzlos
// weg: sie bedeutete "hol das geparkte Ticket zurueck auf in-progress" und
// setzte voraus, dass der Mensch schon geantwortet hatte (`!hasNeedsInput`).
// Dieser Zwischenzustand kann nicht mehr entstehen -- wer antwortet, nimmt
// 'needs-answer' ab, und damit greift der ganz normale `running`-Zweig der
// Auswahl.
export function watchReaction(input: WatchReactionInput): WatchReaction {
  const { state, waiting } = input;

  if (waiting) return state === 'success' ? { kind: 'merge' } : { kind: 'noop' };

  switch (state) {
    case 'pending':
      // #324: haengt der Check laenger als PENDING_STALL_MINUTES, kippt auch
      // ein laufendes Ticket auf Gelb -- unterhalb der Schwelle bleibt es beim
      // bisherigen Gruen (AC3).
      return { kind: 'wait', severity: input.pendingEscalated ? 'yellow' : 'green' };
    case 'success':
      return { kind: 'merge' };
    case 'failing-fix':
      return { kind: 'build-fix' };
    case 'behind-caught-up':
      return { kind: 'wait', severity: 'green' };
    case 'behind-conflict':
      return { kind: 'build-fix' };
    // #217: identische Reaktion wie 'behind-conflict' -- der Unterschied liegt
    // allein darin, WIE der Konflikt festgestellt wurde (GitHubs DIRTY statt
    // eines gescheiterten lokalen Merges) und im Wortlaut der Begruendung.
    case 'dirty-conflict':
      return { kind: 'build-fix' };
    case 'behind-retry':
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
  clock: Clock;
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
  // Nur fuer 'pending', nur bei laufenden Tickets berechnet (#324).
  pendingMinutes?: number;
  pendingEscalated?: boolean;
}

// #324: Zeitpunkt, seit dem ein Ticket UNUNTERBROCHEN auf 'pending' steht --
// dateibasiert unter $STATE_DIR, analog zum Fehlversuchs-Zaehler in
// catchup.ts. Erster Aufruf schreibt den Zeitstempel und meldet 0 Minuten,
// jeder weitere Aufruf rechnet gegen DENSELBEN Zeitstempel weiter.
function pendingKey(issue: number): string {
  return `pending-since-${issue}`;
}

function pendingMinutesSince(issue: number, state: StateAdapter, clock: Clock): number {
  const key = pendingKey(issue);
  const now = clock.now().getTime();
  const raw = state.read(key);
  if (!raw) {
    state.write(key, String(now));
    return 0;
  }
  const since = Number(raw) || now;
  return Math.floor((now - since) / 60_000);
}

// AC4: sobald der PR NICHT mehr auf 'pending' steht (gemerged oder rot),
// verschwindet der Zeitstempel wieder -- ein spaeterer 'pending'-Lauf beginnt
// neu zu zaehlen statt die alte Uhrzeit fortzuschreiben.
function pendingReset(issue: number, state: StateAdapter): void {
  state.remove(pendingKey(issue));
}

// Loest den rohen `PrState` (S4) zu einem `WatchState` auf -- inklusive der
// dafuer noetigen Seiteneffekte (Nachziehen per git, Fehlversuchs-Zaehler
// zuruecksetzen/hochzaehlen, Zusammenfassung roter Checks holen). Identisch
// fuer wartend und laufend; NUR die anschliessende `watchReaction()` wertet
// `waiting` unterschiedlich.
function resolveWatchState(issue: number, pr: string, parked: boolean, deps: WatchDeps): ResolvedWatchState {
  const ciState = prCiState(pr, deps.gh);

  if (ciState === 'pending') {
    // #324: die Zeitmessung ist nur fuer laufende Tickets relevant (siehe
    // Modulkommentar zur behind-retry-Eskalation) -- ein wartendes Ticket
    // bleibt bei 'pending' ohnehin still (watchReaction), der Zeitstempel
    // wuerde nie gelesen.
    if (parked) return { state: 'pending' };
    const pendingMinutes = pendingMinutesSince(issue, deps.state, deps.clock);
    return { state: 'pending', pendingMinutes, pendingEscalated: pendingMinutes >= PENDING_STALL_MINUTES };
  }
  // Jeder andere Zustand beendet eine laufende 'pending'-Phase (AC4) -- fuer
  // wartende Tickets wurde ohnehin nie ein Zeitstempel angelegt.
  if (!parked) pendingReset(issue, deps.state);

  if (ciState === 'success') return { state: 'success' };

  if (ciState === 'failing') return { state: 'failing-fix', failSummary: prFailureSummary(pr, deps.gh) };

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
  | { kind: 'pending'; escalated: boolean; minutes: number }
  | { kind: 'merged' }
  | { kind: 'build-fix'; summary: string }
  | { kind: 'caught-up' }
  | { kind: 'retry'; reason: string; paths: string[]; escalated: boolean };

// CI-Wache fuer EIN laufendes Bau-Ticket (#147/#160/#171), jetzt ueber die
// gemeinsame Uebergangstabelle. `issue`/`pr` sind bereits bekannt (Aufrufer
// hat pr_for_issue() schon ausgewertet).
export function watchRunningIssue(issue: number, pr: string, deps: WatchDeps): RunningWatchResult {
  const resolved = resolveWatchState(issue, pr, false, deps);
  const reaction = watchReaction({
    state: resolved.state,
    waiting: false,
    retryEscalated: resolved.retryEscalated,
    pendingEscalated: resolved.pendingEscalated,
  });

  switch (reaction.kind) {
    case 'wait':
      if (resolved.state === 'pending') {
        return { kind: 'pending', escalated: reaction.severity === 'yellow', minutes: resolved.pendingMinutes ?? 0 };
      }
      if (resolved.state === 'behind-caught-up') return { kind: 'caught-up' };
      if (resolved.state === 'behind-retry') {
        return {
          kind: 'retry',
          reason: resolved.retryReason ?? '',
          paths: resolved.retryPaths ?? [],
          escalated: reaction.severity === 'yellow',
        };
      }
      /* istanbul ignore next -- pending/behind-caught-up/behind-retry sind die einzigen 'wait'-Zustaende */
      return { kind: 'pending', escalated: false, minutes: 0 };
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
      /* istanbul ignore next -- 'noop' kommt fuer waiting:false nie zurueck */
      return { kind: 'pending', escalated: false, minutes: 0 };
  }
}

export interface WaitingIssueInput {
  number: number;
  createdAt: string;
}

export interface WaitingWatchOutcome {
  // Tickets, deren PR in dieser Runde gemerged wurde -- ihr 'needs-answer' ist
  // damit gegenstandslos und wurde abgenommen.
  released: number[];
}

// CI-Wache fuer ALLE wartenden Tickets (#154, erweitert um #173, seit #272 ohne
// Park-Mechanik) -- ueber dieselbe Uebergangstabelle wie watchRunningIssue(),
// mit `waiting: true`.
//
// Ein wartendes Ticket kennt nur noch einen Ausgang, der etwas tut: sein PR
// wird gruen und damit gemerged. Alles andere bleibt still, bis der Mensch
// antwortet -- es wartet auf eine Antwort, nicht auf einen freien Bauplatz.
// Deshalb gibt es hier kein `wipSlotFree` und kein Entparken mehr.
export function watchWaitingIssues(waitingIssues: WaitingIssueInput[], deps: WatchDeps): WaitingWatchOutcome {
  const sorted = [...waitingIssues].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const outcome: WaitingWatchOutcome = { released: [] };

  for (const issue of sorted) {
    const pr = prForIssue(issue.number, deps.gh);
    if (!pr) continue;

    const resolved = resolveWatchState(issue.number, pr, true, deps);
    const reaction = watchReaction({ state: resolved.state, waiting: true });

    if (reaction.kind !== 'merge') continue;

    deps.gh.run(['pr', 'ready', pr]);
    // #217 AC4: 'needs-answer' darf nur weg, wenn der Merge bzw. das Aktivieren
    // von Auto-Merge tatsaechlich geklappt hat -- sonst faellt das Ticket aus
    // jeder Wache heraus, waehrend der PR offen und unbeobachtet liegen bleibt.
    // Schlaegt es fehl, bleibt das Ticket wartend, der naechste Takt versucht
    // es erneut.
    if (!prSquashMerge(pr, deps.gh)) continue;
    deps.gh.run(['issue', 'edit', String(issue.number), '--remove-label', 'needs-answer']);
    outcome.released.push(issue.number);
  }

  return outcome;
}
