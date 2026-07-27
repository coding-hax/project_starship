// Modell-Stufen-Logik, portiert aus claude-runner.sh (#200, S3 von #184).
// Zustand ausschliesslich ueber den `state`-Adapter aus S1 -- Dateinamen und
// -inhalt unter $STATE_DIR bleiben zeichengleich zur Bash-Implementierung,
// damit ein Takt, der ueber einen Versionswechsel hinweg laeuft, denselben
// Zustand vorfindet.
import type { GhAdapter } from './gh.js';
import type { StateAdapter } from './state.js';

export type Tier = 'haiku' | 'sonnet' | 'opus';

function hasHaikuLabel(issue: number, gh: GhAdapter): boolean {
  let output = '';
  try {
    output = gh.run(['issue', 'view', String(issue), '--json', 'labels', '-q', '.labels[].name']);
  } catch {
    return false;
  }
  return output.split('\n').some((line) => line.trim() === 'model:haiku');
}

// Aktuelle Bau-Modellstufe fuer ein Ticket. Kein tier-<nr> (noch nie
// eskaliert) -> Default aus dem Label 'model:haiku', sonst 'sonnet'.
export function tierCurrent(issue: number, state: StateAdapter, gh: GhAdapter): Tier {
  const stored = state.read(`tier-${issue}`);
  if (stored !== null && stored.length > 0) {
    return stored.trim() as Tier;
  }
  return hasHaikuLabel(issue, gh) ? 'haiku' : 'sonnet';
}

// Schaltet eine Stufe hoch. Die Leiter hat nur einen Sprung: sonnet/haiku ->
// opus. Auf opus (Spitze) angekommen: kein weiterer Bump, `false` signalisiert
// "erschoepft" an den Aufrufer.
export function tierBump(issue: number, state: StateAdapter, gh: GhAdapter): boolean {
  if (tierCurrent(issue, state, gh) === 'opus') return false;
  state.write(`tier-${issue}`, 'opus\n');
  state.write(`failcount-${issue}`, '0\n');
  return true;
}

// Zurueck auf die Default-Stufe -- nach Fortschritt (siehe buildEscalationEval).
export function tierReset(issue: number, state: StateAdapter): void {
  state.remove(`tier-${issue}`);
  state.remove(`failcount-${issue}`);
  state.remove(`blocker-sig-${issue}`);
  state.remove(`branch-head-${issue}`);
}
