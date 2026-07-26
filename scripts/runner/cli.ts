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
import {
  prCiState,
  prFailureSummary,
  prForIssue,
  prIsBehind,
  prIsDirty,
  prMergeState,
  prOnlyProtectedPathsRed,
  prSquashMerge,
  reopenFalselyClosedIssues,
} from './pr.js';
import { catchupExitCode, catchupFailEscalated, catchupFailReason, catchupFailReset, catchupStdout, prCatchUpBehind } from './catchup.js';
import { watchParkedIssues, watchRunningIssue, type ParkedIssueInput } from './watch.js';
import { pickTicket, selfHealPark } from './select.js';
import { parkIssue, parkedIssues, queueBody, queueSnapshot, waitingIssues } from './status.js';

export interface RunnerContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
  clock: Clock;
}

// Die meisten Kommandos folgen dem S1-Vertrag: String = Erfolg (stdout + \n,
// Exit 0), `null` = Bash-seitiges `return 1` (Exit 1, kein stdout). Nur
// `pr_catch_up_behind` (#201) braucht die vollen Zahlen-Exitcodes 0-5 seiner
// Bash-Vorlage -- dafuer der dritte Fall mit explizitem exitCode/stdout,
// stdout OHNE angehaengtes '\n' (Konfliktdateien/stoerende Pfade kommagetrennt,
// wie `printf '%s'` auf der Bash-Seite).
export type CommandResult = string | null | { exitCode: number; stdout: string };
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
  'pr-for-issue': (ctx, args) => prForIssue(Number(args[0]), ctx.gh),
  'pr-ci-state': (ctx, args) => prCiState(args[0] ?? '', ctx.gh),
  'pr-is-behind': (ctx, args) => (prIsBehind(args[0] ?? '', ctx.gh) ? '' : null),
  'pr-is-dirty': (ctx, args) => (prIsDirty(args[0] ?? '', ctx.gh) ? '' : null),
  'pr-merge-state': (ctx, args) => {
    const result = prMergeState(args[0] ?? '', ctx.gh);
    return result === null ? null : JSON.stringify(result);
  },
  'pr-catch-up-behind': (ctx, args) => {
    const result = prCatchUpBehind(args[0] ?? '', ctx.git, ctx.gh);
    return { exitCode: catchupExitCode(result), stdout: catchupStdout(result) };
  },
  'catchup-fail-reason': (_ctx, args) => catchupFailReason(Number(args[0])),
  'catchup-fail-escalated': (ctx, args) =>
    catchupFailEscalated(Number(args[0]), args[1] ?? '', ctx.state) ? '' : null,
  'catchup-fail-reset': (ctx, args) => {
    catchupFailReset(Number(args[0]), ctx.state);
    return '';
  },
  'pr-only-protected-paths-red': (ctx, args) => (prOnlyProtectedPathsRed(args[0] ?? '', ctx.gh) ? '' : null),
  // Exit 0 = gemergt bzw. Auto-Merge aktiviert, Exit 1 = gescheitert (#217 AC4).
  'pr-squash-merge': (ctx, args) => (prSquashMerge(args[0] ?? '', ctx.gh) ? '' : null),
  'reopen-falsely-closed-issues': (ctx) => {
    reopenFalselyClosedIssues(ctx.gh);
    return '';
  },
  'pr-failure-summary': (ctx, args) => prFailureSummary(args[0] ?? '', ctx.gh),
  'watch-running-issue': (ctx, args) =>
    JSON.stringify(watchRunningIssue(Number(args[0]), args[1] ?? '', { gh: ctx.gh, git: ctx.git, state: ctx.state })),
  'watch-parked-issues': (ctx, args) =>
    JSON.stringify(
      watchParkedIssues(JSON.parse(args[0] ?? '[]') as ParkedIssueInput[], args[1] === '1', {
        gh: ctx.gh,
        git: ctx.git,
        state: ctx.state,
      }),
    ),
  'self-heal-park': (ctx, args) => JSON.stringify(selfHealPark(JSON.parse(args[0] ?? '[]') as QueueIssue[], ctx.gh)),
  'pick-ticket': (ctx, args) =>
    JSON.stringify(pickTicket(JSON.parse(args[0] ?? '[]') as QueueIssue[], args[1] ?? '', ctx.gh, ctx.state)),
  'waiting-issues': (ctx) => waitingIssues(ctx.gh),
  'parked-issues': (ctx) => parkedIssues(ctx.gh),
  'park-issue': (ctx, args) => (parkIssue(Number(args[0]), ctx.gh) ? '' : null),
  'queue-snapshot': (ctx) => JSON.stringify(queueSnapshot(ctx.gh)),
  'queue-body': (ctx, args) => queueBody(Number(args[0]), ctx.gh),
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
  if (typeof result === 'object') {
    if (result.stdout) process.stdout.write(result.stdout);
    return result.exitCode;
  }
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
