// Modell-Stufen-Logik, portiert aus claude-runner.sh (#200, S3 von #184).
// Zustand ausschliesslich ueber den `state`-Adapter aus S1 -- Dateinamen und
// -inhalt unter $STATE_DIR bleiben zeichengleich zur Bash-Implementierung,
// damit ein Takt, der ueber einen Versionswechsel hinweg laeuft, denselben
// Zustand vorfindet.
import type { GhAdapter } from './gh.js';
import type { StateAdapter } from './state.js';

export type Tier = 'haiku' | 'sonnet' | 'opus';

// Die drei Startstufen-Labels in Praezedenzreihenfolge (ADR-0013). Traegt ein
// Ticket versehentlich mehrere, gewinnt die teuerste: lieber ein Lauf zu teuer
// als einer, der die absichtlich gesetzte Stufe stillschweigend unterbietet.
const TIER_LABELS: [string, Tier][] = [
  ['model:opus', 'opus'],
  ['model:sonnet', 'sonnet'],
  ['model:haiku', 'haiku'],
];

// Die am Ticket gesetzte STARTSTUFE, oder null (kein model:*-Label).
// Getrennt von tierCurrent() exportiert, weil round.ts sie an zwei Stellen
// OHNE den Eskalationszustand braucht: fuer die Denk-Rollen (Label schlaegt
// Rolle) und fuer 'no-escalation' (einfrieren auf der Startstufe).
export function tierFromLabels(issue: number, gh: GhAdapter): Tier | null {
  let output = '';
  try {
    output = gh.run(['issue', 'view', String(issue), '--json', 'labels', '-q', '.labels[].name']);
  } catch {
    return null;
  }
  const names = new Set(output.split('\n').map((line) => line.trim()));
  for (const [label, tier] of TIER_LABELS) {
    if (names.has(label)) return tier;
  }
  return null;
}

// Aktuelle Bau-Modellstufe fuer ein Ticket.
//
// ADR-0013: das Label ist die STARTSTUFE, nicht die Fessel. Eine bereits
// eingetretene Eskalation (tier-<nr>) schlaegt es deshalb -- sonst waere ein
// Ticket mit 'model:sonnet' fuer immer auf Sonnet festgenagelt und ADR-0007
// liefe ins Leere. Ohne Datei und ohne Label bleibt 'sonnet' der Default.
export function tierCurrent(issue: number, state: StateAdapter, gh: GhAdapter): Tier {
  const stored = state.read(`tier-${issue}`);
  if (stored !== null && stored.length > 0) {
    return stored.trim() as Tier;
  }
  return tierFromLabels(issue, gh) ?? 'sonnet';
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
