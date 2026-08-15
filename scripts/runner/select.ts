// Ticketauswahl aus `run_round`, portiert aus claude-runner.sh (#202, S5 von
// #184), seit #272 (S2b von #264) ohne Park-Mechanik.
//
// Praezedenz: laufendes in-progress > next > plan > research > ready, je
// aeltestes createdAt. Die Rolle kommt bei 'next' weiter aus dem eigenen
// Rollenlabel (roleFromLabels()) -- 'next' selbst ist nur der Rang (#725, S2
// von ADR-0023).
//
// Was hier frueher stand und warum es weg ist (#272): `selfHealPark()` nahm
// einem wartenden Ticket `in-progress` weg und gab ihm `parked`. Genau deshalb
// brauchte es danach einen eigenen `resume-parked`-Zweig, um dasselbe Ticket
// wiederzufinden, eine eigene Wache dafuer, und ein Sicherheitsnetz gegen den
// Zwischenzustand `in-progress` + Wartelabel. Alle vier existierten nur wegen
// des Umlabelns.
//
// Jetzt bleibt `in-progress` einfach stehen. Der `running`-Zweig ueberspringt
// Tickets mit `needs-answer` -- sie belegen also keinen Bauplatz -- und
// derselbe Zweig setzt die Arbeit fort, sobald der Mensch das Label abnimmt.
// Kein Label-Schreibvorgang, kein zweiter Zweig, kein Zwischenzustand.
//
// `RUN_ROLE` kommt weiter aus dem Label ('plan' -> plan, 'research' ->
// research, sonst build) -- unveraendert aus ADR-0005. Der eigentliche
// `claude`-Aufruf (Prompt/Modell/Tools je Rolle) bleibt bewusst in
// claude-runner.sh (S6, siehe Nicht-Ziele von #202).
import type { GhAdapter } from './gh.js';
import type { StateAdapter } from './state.js';
import { byCreatedAt, entriesFromIssues, hasLabel, queueBlocked, type QueueIssue } from './queue.js';
import { sessionKey } from './session.js';

export type RunRole = 'build' | 'plan' | 'research';

// Rollenableitung aus den Labels -- einzige Quelle, von running/next (hier)
// UND vom Resume-Zweig in round.ts benutzt (#387), damit alle drei Stellen
// beweisbar synchron bleiben.
export function roleFromLabels(issue: QueueIssue): RunRole {
  return hasLabel(issue, 'plan') ? 'plan' : hasLabel(issue, 'research') ? 'research' : 'build';
}

// Labels, die ein Ticket VOLLSTAENDIG aus der Auswahl nehmen -- auf jedem
// Zweig, nicht nur auf dem, an den gerade jemand gedacht hat (#266).
//
// Diese Liste ist die einzige Quelle dafuer. Sie steht hier oben und nicht
// inline im Filter, weil label-contract.test.ts sie liest: die Suite fuehrt
// jedes Label aus dieser Liste durch JEDEN Auswahlzweig und besteht darauf,
// dass keiner es durchlaesst. Ein neuer Zweig, der die zentrale Filterung
// umgeht, faellt damit auf, statt jahrelang unbemerkt zu bleiben.
//
// Der Anlass, in einem Satz: 'no-opus' (heute 'hands-off') beschrieb sich als
// "der Runner fasst das Ticket gar nicht an", wurde aber in drei von sechs
// Zweigen nicht geprueft. Gemerkt hat das niemand, bis am 26.07.26 ein
// ungewollter Opus-Bau-Lauf auf einem lokal bearbeiteten Ticket startete.
// Eine Beschreibung, die luegt, ist schlimmer als keine -- man verlaesst sich
// darauf.
// NICHT dabei: 'blocked-by'. Es ist die ANZEIGE einer Queue-Abhaengigkeit,
// nicht ihre Ursache -- die steht als Zeile in der Queue und wird bei jeder
// Auswahl frisch ausgewertet (#265). Als Blocker gefuehrt wuerde das Label die
// Freigabe um einen ganzen Takt verzoegern: der Runner nimmt es zwar ab, sobald
// die Voraussetzung faellt, sieht es aber im selben Schnappschuss noch.
export const BLOCKING_LABELS = ['hands-off', 'needs-answer'] as const;

export interface SelectedTicket {
  issue: number;
  role: RunRole;
  // Herkunft der Wahl -- bestimmt in pickTicket(), welche Label-Mutation und
  // welcher MODE (start/resume) noetig sind.
  source: 'running' | 'next' | 'plan' | 'research' | 'ready';
}

// Die reine Auswahl-Kaskade, OHNE Seiteneffekte. `claimedElsewhere` (#204):
// Issues, die ein ANDERER Slot beansprucht -- zusaetzlich zu BLOCKING_LABELS
// aus `selectable` ausgeschlossen. Bewusst NICHT aus `snapshot` selbst entfernt:
// `openIssues`/`queueBlocked` unten braucht den vollen Bestand, sonst saehe ein
// abhaengiges Ticket seinen von einem anderen Slot bearbeiteten Blocker
// faelschlich als erledigt an (siehe claimedElsewhere() in claim.ts).
export function selectTicket(
  snapshot: QueueIssue[],
  claimedElsewhere: ReadonlySet<number> = new Set(),
): SelectedTicket | null {
  // #227: 'hands-off' ist ein Kill-Switch fuer das ganze Ticket, kein Detail
  // einzelner Zweige. Einmal zentral gefiltert, bevor irgendein Zweig den
  // Snapshot sieht: ein hands-off-Ticket ist fuer die Auswahl schlicht nicht
  // vorhanden, und der naechste neue Zweig erbt das, statt die Bedingung zu
  // vergessen.
  //
  // #272: 'needs-answer' wird aus demselben Grund gleich mitgefiltert. Es war
  // vorher je Zweig wiederholt -- und ausgerechnet im Zweig, der zuerst greift,
  // stand es einmal nicht.
  //
  // #265/#724: Abhaengigkeiten ('Nach: #227' im TICKET-Body, seit #725 die
  // einzige Quelle) gehoeren aus demselben Grund hierher und nicht in den
  // next-Zweig: ein wartendes Ticket darf auch nicht ueber den ready- oder
  // plan-Zweig hereinrutschen. Die Voraussetzung gilt als erfuellt, sobald ihr
  // Ticket nicht mehr im Snapshot offener Tickets steht -- ausgewertet bei
  // JEDER Auswahl, damit nichts veraltet.
  const entries = entriesFromIssues(snapshot);
  const openIssues = new Set(snapshot.map((issue) => issue.number));
  const blocked = queueBlocked(entries, openIssues);
  const selectable = snapshot.filter(
    (issue) =>
      !BLOCKING_LABELS.some((label) => hasLabel(issue, label)) &&
      !blocked.has(issue.number) &&
      !claimedElsewhere.has(issue.number),
  );

  const running = selectable.filter((issue) => hasLabel(issue, 'in-progress')).sort(byCreatedAt)[0];
  if (running) return { issue: running.number, role: roleFromLabels(running), source: 'running' };

  // #725 (S2 von ADR-0023): die Prioritaets-Queue ist jetzt "alle Tickets mit
  // `next`", je aeltestes createdAt -- kein Zeilenrang mehr, sondern derselbe
  // Label-Filter wie plan/research/ready darunter. Die ROLLE kommt weiter aus
  // dem Label (roleFromLabels()); `next` selbst sagt nichts ueber die Rolle.
  const nextUp = selectable.filter((issue) => hasLabel(issue, 'next')).sort(byCreatedAt)[0];
  if (nextUp) return { issue: nextUp.number, role: roleFromLabels(nextUp), source: 'next' };

  const nextPlan = selectable.filter((issue) => hasLabel(issue, 'plan')).sort(byCreatedAt)[0];
  if (nextPlan) return { issue: nextPlan.number, role: 'plan', source: 'plan' };

  const nextResearch = selectable.filter((issue) => hasLabel(issue, 'research')).sort(byCreatedAt)[0];
  if (nextResearch) return { issue: nextResearch.number, role: 'research', source: 'research' };

  const nextReady = selectable
    .filter((issue) => hasLabel(issue, 'ready') && !hasLabel(issue, 'plan') && !hasLabel(issue, 'research'))
    .sort(byCreatedAt)[0];
  if (nextReady) return { issue: nextReady.number, role: 'build', source: 'ready' };

  return null;
}

// Das Ticket, das der Runner beim naechsten Takt naehme -- fuer die Anzeige im
// Status-Issue. Bis #271 war das eine zweite, von Hand gepflegte Kaskade in
// queue.ts, die regelmaessig abdriftete. Jetzt ist es dieselbe Funktion: eine
// Anzeige, die ein anderes Ticket nennt als das, was der Runner dann baut, ist
// schlimmer als gar keine -- man trifft Label-Entscheidungen auf ihrer
// Grundlage, und zwar vom Handy aus, wo sich nichts nachpruefen laesst.
//
// Nur die Nummer, keine Rolle: die Anzeige braucht nicht mehr. Wer die Rolle
// braucht, ruft `selectTicket()` selbst.
export function queueNext(snapshot: QueueIssue[]): number | null {
  return selectTicket(snapshot)?.issue ?? null;
}

export type SelectOutcome =
  | { kind: 'ticket'; issue: number; role: RunRole; mode: 'start' | 'resume' }
  | { kind: 'none' };

// Orchestrierung: `selectTicket()` waehlt, `pickTicket()` fuehrt die dafuer
// noetige Label-Mutation aus und bestimmt MODE (start/resume).
export function pickTicket(
  snapshot: QueueIssue[],
  gh: GhAdapter,
  state: StateAdapter,
  claimedElsewhere: ReadonlySet<number> = new Set(),
): SelectOutcome {
  const selected = selectTicket(snapshot, claimedElsewhere);
  if (!selected) return { kind: 'none' };

  // `-s` in der Bash-Vorlage prueft Existenz UND Groesse > 0, nicht nur
  // Existenz -- eine leere Session-Datei (kaputter/leerer Claude-Output,
  // siehe scripts/tests/round-snap.test.sh AC7) zaehlt als "keine Session".
  const hasSession = (issue: number, role: RunRole) => {
    const content = state.read(sessionKey(issue, role));
    return content !== null && content.length > 0;
  };

  switch (selected.source) {
    case 'running':
      // Das Ticket traegt bereits 'in-progress' -- nichts umzuschreiben. Das
      // ist auch der Weg, auf dem ein beantwortetes Ticket zurueckkommt (#272).
      // Rolle kommt aus den Labels (#387): ein fortgesetzter Denk-Lauf bleibt
      // Denk-Lauf, statt hart als Bau-Lauf zurueckzukommen.
      return {
        kind: 'ticket',
        issue: selected.issue,
        role: selected.role,
        mode: selected.role === 'build' ? 'resume' : hasSession(selected.issue, selected.role) ? 'resume' : 'start',
      };
    case 'next':
      // #725 AK3: 'next' faellt beim Start eines Bau-Laufs NICHT weg -- es
      // verschwindet erst mit dem Ticket selbst (Schliessen/Merge). Nur
      // 'ready' wird abgenommen, wie bisher im 'queue'-Zweig.
      if (selected.role === 'build') {
        gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
        return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
      }
      // #387 AC1: auch ein Denk-Ticket mit 'next' bekommt in-progress dazu --
      // ready bleibt unberuehrt (nur add, kein remove).
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress']);
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue, selected.role) ? 'resume' : 'start' };
    case 'plan':
    case 'research':
      // #387 AC1: Denk-Rollen tragen ab jetzt in-progress, solange sie laufen
      // -- sichtbar am Handy und haelt den Slot-Claim (claim.ts).
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress']);
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue, selected.role) ? 'resume' : 'start' };
    case 'ready':
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
  }
}
