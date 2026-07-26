#!/usr/bin/env node
// Dispatcher der Bash<->TS-Naht (#198/#199). Vertrag je Kommando: stdout +
// Exit-Code exakt wie die Bash-Funktion, die es ersetzt. `ts_run()` in
// scripts/claude-runner.sh ruft genau diese Datei auf.
//
// Adapter (gh/git/state/clock) werden hier zu einem RunnerContext verdrahtet
// und NIE global importiert -- Kommandos bekommen sie als Parameter, damit
// Vitest sie durch Doubles ersetzen kann, ohne Netz oder echtes .runner/
// anzufassen.
//
// Ein Handler gibt entweder einen String zurueck (Erfolg, Exit 0 -- '' ist
// ein gueltiger LEERER Erfolg, z. B. "keine Queue-Arbeit offen") oder `null`
// (die Bash-Seite haette `return 1` gemacht: Exit 1, GAR KEIN stdout).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock, type Clock } from './clock.js';
import { createGhAdapter, type GhAdapter } from './gh.js';
import { createGitAdapter, type GitAdapter } from './git.js';
import { dPlus, fmtHm, resetEpoch } from './time.js';
import { queueNext, queuePending, queueOrderFlat, type QueueIssue } from './queue.js';
import { createStateAdapter, type StateAdapter } from './state.js';
import { tierBump, tierCurrent, tierReset } from './tier.js';
import { blockerSig, buildEscalationEval, resumeAllowed, sha1Of } from './escalation.js';
import { opusBuildCapReached, opusBuildCapReserve } from './cap.js';

export interface RunnerContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
  clock: Clock;
}

export type CommandResult = string | null;
export type CommandHandler = (ctx: RunnerContext, args: string[]) => CommandResult;

const here = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const raw = readFileSync(join(here, '..', '..', 'package.json'), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

export const commands: Record<string, CommandHandler> = {
  version: () => readPackageVersion(),
  'fmt-hm': (_ctx, args) => fmtHm(Number(args[0])),
  'd-plus': (ctx, args) => dPlus(Number(args[0]), args[1] ?? '', ctx.clock),
  'reset-epoch': (ctx, args) => {
    const epoch = resetEpoch(args[0] ?? '', ctx.clock);
    return epoch === null ? null : String(epoch);
  },
  'queue-order-flat': (_ctx, args) => JSON.stringify(queueOrderFlat(args[0] ?? '')),
  'queue-pending': (_ctx, args) => queuePending(JSON.parse(args[0] ?? '[]') as QueueIssue[]),
  'queue-next': (_ctx, args) => {
    const next = queueNext(JSON.parse(args[0] ?? '[]') as QueueIssue[], args[1] ?? '');
    return next === null ? '' : String(next);
  },
  'sha1-of': (_ctx, args) => sha1Of(args[0] ?? ''),
  'tier-current': (ctx, args) => tierCurrent(Number(args[0]), ctx.state, ctx.gh),
  'tier-bump': (ctx, args) => (tierBump(Number(args[0]), ctx.state, ctx.gh) ? '' : null),
  'tier-reset': (ctx, args) => {
    tierReset(Number(args[0]), ctx.state);
    return '';
  },
  'resume-allowed': (ctx, args) => (resumeAllowed(Number(args[0]), ctx.state).allowed ? '' : null),
  'blocker-sig': (ctx, args) => blockerSig(Number(args[0]), ctx.gh),
  'build-escalation-eval': (ctx, args) => {
    buildEscalationEval(
      {
        issue: Number(args[0]),
        runRole: args[1] ?? '',
        labels: args[2] ?? '',
        beforeTip: args[3] ?? '',
        model: args[4] ?? '',
      },
      ctx.state,
      ctx.gh,
      ctx.git,
    );
    return '';
  },
  'opus-cap-reached': (ctx, args) =>
    opusBuildCapReached(Number(args[0]), args[1] ?? '', ctx.state, ctx.clock) ? '' : null,
  'opus-cap-reserve': (ctx, args) => {
    opusBuildCapReserve(Number(args[0]), ctx.state, ctx.clock);
    return '';
  },
};

export function dispatch(ctx: RunnerContext, argv: string[]): number {
  const [cmd, ...rest] = argv;
  const handler = cmd ? commands[cmd] : undefined;
  if (!handler) {
    process.stderr.write(`unbekanntes Kommando: ${cmd ?? '(keins)'}\n`);
    return 2;
  }
  const result = handler(ctx, rest);
  if (result === null) return 1;
  process.stdout.write(`${result}\n`);
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
