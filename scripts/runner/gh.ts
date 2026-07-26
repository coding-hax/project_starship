// Adapter um die `gh`-Aufrufe, injizierbar -- Vitest ersetzt `exec` durch ein
// Double, damit keine Suite echtes Netz anfasst (#198).
import { execFileSync } from 'node:child_process';

export interface GhAdapter {
  run(args: string[]): string;
}

export type ExecFn = (cmd: string, args: string[]) => string;

const defaultExec: ExecFn = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });

export function createGhAdapter(exec: ExecFn = defaultExec): GhAdapter {
  return {
    // Trailing Newlines abschneiden, wie bash `$(...)` es fuer jede
    // Kommandosubstitution tut -- ohne das haengt z.B. ein mehrzeiliger
    // Log-Ausschnitt eine zusaetzliche Leerzeile an, die die Bash-Vorlage nie
    // hatte (siehe scripts/runner/pr.ts, `prFailureSummary()`).
    run: (args) => exec('gh', args).replace(/\r?\n+$/, ''),
  };
}
