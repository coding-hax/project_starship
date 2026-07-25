#!/usr/bin/env node
// Dispatcher der Bash<->TS-Naht (#198, Stufe 1 von 6 aus #184). Vertrag je
// Kommando: stdout + Exit-Code exakt wie die Bash-Funktion, die es ersetzt.
// `ts_run()` in scripts/claude-runner.sh ruft genau diese Datei auf.
//
// Adapter (gh/git/state/clock) werden hier zu einem RunnerContext verdrahtet
// und NIE global importiert -- Kommandos bekommen sie als Parameter, damit
// Vitest sie durch Doubles ersetzen kann, ohne Netz oder echtes .runner/
// anzufassen. `version` ist die einzige Handler-Implementierung dieser
// Stufe; ab S2 wandert echte Bash-Logik hier ein, ein Eintrag je Kommando.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock, type Clock } from './clock.js';
import { createGhAdapter, type GhAdapter } from './gh.js';
import { createGitAdapter, type GitAdapter } from './git.js';
import { createStateAdapter, type StateAdapter } from './state.js';

export interface RunnerContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
  clock: Clock;
}

export type CommandHandler = (ctx: RunnerContext, args: string[]) => string;

const here = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

export const commands: Record<string, CommandHandler> = {
  version: () => readPackageVersion(),
};

export function dispatch(ctx: RunnerContext, argv: string[]): number {
  const [cmd, ...rest] = argv;
  const handler = cmd ? commands[cmd] : undefined;
  if (!handler) {
    process.stderr.write(`unbekanntes Kommando: ${cmd ?? '(keins)'}\n`);
    return 2;
  }
  process.stdout.write(`${handler(ctx, rest)}\n`);
  return 0;
}

function defaultContext(): RunnerContext {
  return {
    gh: createGhAdapter(),
    git: createGitAdapter(),
    state: createStateAdapter(process.env.STATE_DIR ?? join(here, '..', '..', '.runner')),
    clock: createClock(),
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = dispatch(defaultContext(), process.argv.slice(2));
}
