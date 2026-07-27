// Ticketauswahl aus `run_round`, portiert aus claude-runner.sh (#202, S5 von
// #184), seit #272 (S2b von #264) ohne Park-Mechanik.
//
// Praezedenz: laufendes in-progress > Prioritaets-Queue (Label egal) > plan >
// research > ready, je aeltestes createdAt.
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
import { byCreatedAt, hasLabel, queueOrderFlat, type QueueIssue } from './queue.js';

export type RunRole = 'build' | 'plan' | 'research';

export interface SelectedTicket {
  issue: number;
  role: RunRole;
  // Herkunft der Wahl -- bestimmt in pickTicket(), welche Label-Mutation und
  // welcher MODE (start/resume) noetig sind.
  source: 'running' | 'queue' | 'plan' | 'research' | 'ready';
}

// Die reine Auswahl-Kaskade, OHNE Seiteneffekte.
export function selectTicket(snapshot: QueueIssue[], queueBody = ''): SelectedTicket | null {
  // #227: 'hands-off' ist ein Kill-Switch fuer das ganze Ticket, kein Detail
  // einzelner Zweige. Einmal zentral gefiltert, bevor irgendein Zweig den
  // Snapshot sieht: ein hands-off-Ticket ist fuer die Auswahl schlicht nicht
  // vorhanden, und der naechste neue Zweig erbt das, statt die Bedingung zu
  // vergessen.
  //
  // #272: 'needs-answer' wird aus demselben Grund gleich mitgefiltert. Es war
  // vorher je Zweig wiederholt -- und ausgerechnet im Zweig, der zuerst greift,
  // stand es einmal nicht.
  const selectable = snapshot.filter((issue) => !hasLabel(issue, 'hands-off') && !hasLabel(issue, 'needs-answer'));

  const running = selectable.filter((issue) => hasLabel(issue, 'in-progress')).sort(byCreatedAt)[0];
  if (running) return { issue: running.number, role: 'build', source: 'running' };

  const order = queueOrderFlat(queueBody);
  if (order.length > 0) {
    const ranked = selectable
      .filter((issue) => order.includes(issue.number))
      .sort((a, b) => order.indexOf(a.number) - order.indexOf(b.number));
    if (ranked.length > 0) {
      const picked = ranked[0];
      const role: RunRole = hasLabel(picked, 'plan') ? 'plan' : hasLabel(picked, 'research') ? 'research' : 'build';
      return { issue: picked.number, role, source: 'queue' };
    }
  }

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
export function queueNext(snapshot: QueueIssue[], queueBody = ''): number | null {
  return selectTicket(snapshot, queueBody)?.issue ?? null;
}

export type SelectOutcome =
  | { kind: 'ticket'; issue: number; role: RunRole; mode: 'start' | 'resume' }
  | { kind: 'none' };

// Orchestrierung: `selectTicket()` waehlt, `pickTicket()` fuehrt die dafuer
// noetige Label-Mutation aus und bestimmt MODE (start/resume).
export function pickTicket(snapshot: QueueIssue[], queueBody: string, gh: GhAdapter, state: StateAdapter): SelectOutcome {
  const selected = selectTicket(snapshot, queueBody);
  if (!selected) return { kind: 'none' };

  // `-s` in der Bash-Vorlage prueft Existenz UND Groesse > 0, nicht nur
  // Existenz -- eine leere Session-Datei (kaputter/leerer Claude-Output,
  // siehe scripts/tests/round-snap.test.sh AC7) zaehlt als "keine Session".
  const hasSession = (issue: number) => {
    const content = state.read(`session-${issue}`);
    return content !== null && content.length > 0;
  };

  switch (selected.source) {
    case 'running':
      // Das Ticket traegt bereits 'in-progress' -- nichts umzuschreiben. Das
      // ist auch der Weg, auf dem ein beantwortetes Ticket zurueckkommt (#272).
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'resume' };
    case 'queue':
      if (selected.role === 'build') {
        gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
        return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
      }
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue) ? 'resume' : 'start' };
    case 'plan':
    case 'research':
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue) ? 'resume' : 'start' };
    case 'ready':
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
  }
}
