// Ticketauswahl aus `run_round`, portiert aus claude-runner.sh (#202, S5 von
// #184). Zwei getrennte Schritte, wie schon in der Bash-Vorlage:
//
//   1. `selfHealPark()` (#145): ein Ticket, das gleichzeitig `in-progress`
//      UND `needs-input` traegt (eine Frage waehrend eines Laufs), verliert
//      `in-progress` und wird `parked` -- sichtbar wartend, ohne Bauplatz zu
//      belegen. Muss VOR jeder Ticketwahl laufen.
//   2. `selectTicket()` (reine Funktion) + `pickTicket()` (Orchestrierung):
//      dieselbe Praezedenz wie bisher --
//      laufendes in-progress > Resume eines geparkten Tickets (#145,
//      MODE=resume statt neu anzufangen) > Prioritaets-Queue (S2, Label
//      egal) > needs-plan > needs-research > ready, je aeltestes createdAt.
//
// `RUN_ROLE` kommt weiter aus dem Label ('needs-plan' -> plan,
// 'needs-research' -> research, sonst build) -- unveraendert aus ADR-0005.
// Der eigentliche `claude`-Aufruf (Prompt/Modell/Tools je Rolle) bleibt
// bewusst in claude-runner.sh (S6, siehe Nicht-Ziele von #202).
import type { GhAdapter } from './gh.js';
import type { StateAdapter } from './state.js';
import { byCreatedAt, hasLabel, queueOrderFlat, type QueueIssue } from './queue.js';
import { parkIssue } from './status.js';

export type RunRole = 'build' | 'plan' | 'research';

export interface SelfHealResult {
  snapshot: QueueIssue[];
  parked: number[];
}

// #145: 'in-progress' + 'needs-input' gleichzeitig darf nicht koexistieren --
// hinterlaesst eine waehrend eines Laufs gestellte Frage. Nur ERFOLGREICH
// umgelabelte Tickets werden auch im Snapshot umgeschrieben; schlaegt der
// gh-Aufruf fehl, bleibt das Ticket in-progress+needs-input (faellt dann in
// den Sicherheitsnetz-Zweig von `pickTicket()`, siehe unten).
export function selfHealPark(snapshot: QueueIssue[], gh: GhAdapter): SelfHealResult {
  const candidates = snapshot.filter((issue) => hasLabel(issue, 'in-progress') && hasLabel(issue, 'needs-input'));
  const parked: number[] = [];

  for (const issue of candidates) {
    if (parkIssue(issue.number, gh)) parked.push(issue.number);
  }

  const updated = snapshot.map((issue) => {
    if (!parked.includes(issue.number)) return issue;
    return { ...issue, labels: [...issue.labels.filter((l) => l.name !== 'in-progress'), { name: 'parked' }] };
  });
  return { snapshot: updated, parked };
}

export interface SelectedTicket {
  issue: number;
  role: RunRole;
  // Herkunft der Wahl -- bestimmt in pickTicket(), welche Label-Mutation und
  // welcher MODE (start/resume) noetig sind.
  source: 'running' | 'resume-parked' | 'queue' | 'needs-plan' | 'needs-research' | 'ready';
}

// Die reine Auswahl-Kaskade, OHNE Seiteneffekte -- Praezedenz identisch zur
// bisherigen Bash-Implementierung: laufendes in-progress > Resume eines
// geparkten Tickets > Prioritaets-Queue (Label egal) > needs-plan >
// needs-research > ready, je aeltestes createdAt.
export function selectTicket(snapshot: QueueIssue[], queueBody = ''): SelectedTicket | null {
  const running = snapshot
    .filter((issue) => hasLabel(issue, 'in-progress') && !hasLabel(issue, 'needs-input'))
    .sort(byCreatedAt)[0];
  if (running) return { issue: running.number, role: 'build', source: 'running' };

  const resumeParked = snapshot
    .filter((issue) => hasLabel(issue, 'parked') && !hasLabel(issue, 'needs-input'))
    .sort(byCreatedAt)[0];
  if (resumeParked) return { issue: resumeParked.number, role: 'build', source: 'resume-parked' };

  const order = queueOrderFlat(queueBody);
  if (order.length > 0) {
    const ranked = snapshot
      .filter((issue) => order.includes(issue.number))
      .filter((issue) => !hasLabel(issue, 'needs-input') && !hasLabel(issue, 'no-opus'))
      .sort((a, b) => order.indexOf(a.number) - order.indexOf(b.number));
    if (ranked.length > 0) {
      const picked = ranked[0];
      const role: RunRole = hasLabel(picked, 'needs-plan') ? 'plan' : hasLabel(picked, 'needs-research') ? 'research' : 'build';
      return { issue: picked.number, role, source: 'queue' };
    }
  }

  const nextNeedsPlan = snapshot
    .filter((issue) => hasLabel(issue, 'needs-plan') && !hasLabel(issue, 'needs-input') && !hasLabel(issue, 'no-opus'))
    .sort(byCreatedAt)[0];
  if (nextNeedsPlan) return { issue: nextNeedsPlan.number, role: 'plan', source: 'needs-plan' };

  const nextNeedsResearch = snapshot
    .filter((issue) => hasLabel(issue, 'needs-research') && !hasLabel(issue, 'needs-input') && !hasLabel(issue, 'no-opus'))
    .sort(byCreatedAt)[0];
  if (nextNeedsResearch) return { issue: nextNeedsResearch.number, role: 'research', source: 'needs-research' };

  const nextReady = snapshot
    .filter(
      (issue) =>
        hasLabel(issue, 'ready') &&
        !hasLabel(issue, 'needs-input') &&
        !hasLabel(issue, 'needs-plan') &&
        !hasLabel(issue, 'needs-research'),
    )
    .sort(byCreatedAt)[0];
  if (nextReady) return { issue: nextReady.number, role: 'build', source: 'ready' };

  return null;
}

export type SelectOutcome =
  // Sicherheitsnetz (#145): trotz selfHealPark() traegt noch ein Ticket
  // in-progress+needs-input (der gh-Aufruf dort ist gescheitert) -- lieber
  // blockieren als riskant ein zweites Ticket parallel anzufangen.
  | { kind: 'blocked'; issues: number[] }
  | { kind: 'ticket'; issue: number; role: RunRole; mode: 'start' | 'resume' }
  | { kind: 'none' };

// Orchestrierung: `selectTicket()` waehlt, `pickTicket()` fuehrt die dafuer
// noetige Label-Mutation aus und bestimmt MODE (start/resume). `snapshot`
// muss bereits durch `selfHealPark()` gelaufen sein.
export function pickTicket(snapshot: QueueIssue[], queueBody: string, gh: GhAdapter, state: StateAdapter): SelectOutcome {
  const stillBlocked = snapshot.filter((issue) => hasLabel(issue, 'in-progress') && hasLabel(issue, 'needs-input'));
  if (stillBlocked.length > 0) {
    return { kind: 'blocked', issues: stillBlocked.map((issue) => issue.number) };
  }

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
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'resume' };
    case 'resume-parked':
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'parked']);
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'resume' };
    case 'queue':
      if (selected.role === 'build') {
        gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
        return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
      }
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue) ? 'resume' : 'start' };
    case 'needs-plan':
    case 'needs-research':
      return { kind: 'ticket', issue: selected.issue, role: selected.role, mode: hasSession(selected.issue) ? 'resume' : 'start' };
    case 'ready':
      gh.run(['issue', 'edit', String(selected.issue), '--add-label', 'in-progress', '--remove-label', 'ready']);
      return { kind: 'ticket', issue: selected.issue, role: 'build', mode: 'start' };
  }
}
