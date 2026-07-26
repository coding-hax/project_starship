// Adapter um die `git`-Aufrufe, injizierbar -- gleiches Muster wie gh.ts (#198).
import { execFileSync } from 'node:child_process';

export interface GitAdapter {
  run(args: string[]): string;
}

export type ExecFn = (cmd: string, args: string[]) => string;

const defaultExec: ExecFn = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });

export function createGitAdapter(exec: ExecFn = defaultExec): GitAdapter {
  return {
    // Trailing Newlines abschneiden, wie bash `$(...)` es fuer jede
    // Kommandosubstitution tut -- gleiches Muster wie gh.ts.
    run: (args) => exec('git', args).replace(/\r?\n+$/, ''),
  };
}
