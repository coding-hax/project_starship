// Adapter um die `git`-Aufrufe, injizierbar -- gleiches Muster wie gh.ts (#198).
import { execFileSync } from 'node:child_process';

export interface GitAdapter {
  // cwd optional (#665): Catch-up muss im Worktree laufen koennen, der den
  // Branch haelt, statt immer im Prozess-cwd. Weggelassen = bisheriges
  // Verhalten, alle bestehenden Aufrufer bleiben unveraendert gueltig.
  run(args: string[], cwd?: string): string;
}

export type ExecFn = (cmd: string, args: string[], cwd?: string) => string;

const defaultExec: ExecFn = (cmd, args, cwd) => execFileSync(cmd, args, { encoding: 'utf-8', cwd });

export function createGitAdapter(exec: ExecFn = defaultExec): GitAdapter {
  return {
    // Trailing Newlines abschneiden, wie bash `$(...)` es fuer jede
    // Kommandosubstitution tut -- gleiches Muster wie gh.ts.
    run: (args, cwd) => exec('git', args, cwd).replace(/\r?\n+$/, ''),
  };
}
