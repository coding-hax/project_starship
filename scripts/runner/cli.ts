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
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock, type Clock } from './clock.js';
import { createGhAdapter, type GhAdapter } from './gh.js';
import { createGitAdapter, type GitAdapter } from './git.js';
import { dPlus, fmtHm, resetEpoch } from './time.js';
import { queuePending, queueOrderFlat, type QueueIssue } from './queue.js';
import { createStateAdapter, type StateAdapter } from './state.js';
import { createClaimAdapter, type ClaimAdapter } from './claim.js';
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
  prSquashMerge,
  reopenFalselyClosedIssues,
} from './pr.js';
import { catchupExitCode, catchupFailEscalated, catchupFailReason, catchupFailReset, catchupStdout, prCatchUpBehind } from './catchup.js';
import { watchWaitingIssues, watchRunningIssue, type WaitingIssueInput } from './watch.js';
import { pickTicket, queueNext } from './select.js';
import { queueBody, queueSnapshot, waitingIssues } from './status.js';
import { roundEval, roundPlan, type RoundRun } from './round.js';
import { cleanupStateDir } from './cleanup.js';
import { shimDriftReason } from './shim.js';

export interface RunnerContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
  /** Slotübergreifend unter SHARED_DIR (#204) -- siehe round.ts, roundEval. */
  sharedState: StateAdapter;
  /** Slotübergreifend unter SHARED_DIR/claims (#204), siehe claim.ts. */
  claims: ClaimAdapter;
  /** Dieser Slot -- '1' in der Ein-Slot-Welt (AK9). */
  slotId: string;
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
  // $1 = installierter Pfad, $2 = Ref. '' = kein Drift (#252).
  'shim-drift-reason': (ctx, args) => shimDriftReason(args[0] ?? '', args[1] ?? 'origin/main', ctx.git),
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
  // Exit 0 = gemergt bzw. Auto-Merge aktiviert, Exit 1 = gescheitert (#217 AC4).
  'pr-squash-merge': (ctx, args) => (prSquashMerge(args[0] ?? '', ctx.gh) ? '' : null),
  'reopen-falsely-closed-issues': (ctx) => {
    reopenFalselyClosedIssues(ctx.gh);
    return '';
  },
  'pr-failure-summary': (ctx, args) => prFailureSummary(args[0] ?? '', ctx.gh),
  'watch-running-issue': (ctx, args) =>
    JSON.stringify(watchRunningIssue(Number(args[0]), args[1] ?? '', { gh: ctx.gh, git: ctx.git, state: ctx.state })),
  'watch-waiting-issues': (ctx, args) =>
    JSON.stringify(
      watchWaitingIssues(JSON.parse(args[0] ?? '[]') as WaitingIssueInput[], {
        gh: ctx.gh,
        git: ctx.git,
        state: ctx.state,
      }),
    ),
  'pick-ticket': (ctx, args) =>
    JSON.stringify(pickTicket(JSON.parse(args[0] ?? '[]') as QueueIssue[], args[1] ?? '', ctx.gh, ctx.state)),
  'waiting-issues': (ctx) => waitingIssues(ctx.gh),
  'cleanup-state': (ctx) => {
    cleanupStateDir(stateDir(), ctx.gh, ctx.clock.now().getTime(), ctx.claims, ctx.slotId);
    return '';
  },
  'queue-snapshot': (ctx) => JSON.stringify(queueSnapshot(ctx.gh)),
  'queue-body': (ctx, args) => queueBody(Number(args[0]), ctx.gh),

  // --- Das Rundenprotokoll (#203, S6) --------------------------------------
  // Drei Kommandos statt der bisherigen ~40 Einzelaufrufe pro Takt. Die Runde
  // zerfaellt genau am `claude`-Aufruf, der in Bash bleibt (AK6/AK7).
  'round-plan': (ctx, args) =>
    JSON.stringify(
      roundPlan(ctx, {
        queueIssue: Number(args[0] ?? 0),
        maxRuntime: Number(args[1] ?? 2700),
        didWork: args[2] === '1',
        lastIssue: args[3] ?? '',
        // $IS_LEAD aus claude-runner.sh (#204) -- '1' in der Ein-Slot-Welt.
        isLead: args[4] === '1',
      }),
    ),

  // AK6 woertlich: TS schreibt den Prompt nach stdout, Bash pipet ihn in
  // `claude`. Bewusst NUR ein Feld aus dem bereits gefassten Plan -- roundPlan
  // ein zweites Mal zu rufen wuerde seine Seiteneffekte (Labels, Kommentare,
  // Opus-Deckel) verdoppeln.
  'round-prompt': (_ctx, args) => {
    const plan = JSON.parse(readFileSync(args[0] ?? '', 'utf-8')) as { prompt?: string };
    return plan.prompt ?? '';
  },

  'round-eval': (ctx, args) => {
    const plan = JSON.parse(readFileSync(args[0] ?? '', 'utf-8')) as RoundRun;
    const logPath = args[4] ?? '';
    let log = '';
    try {
      log = readFileSync(logPath, 'utf-8');
    } catch {
      log = '';
    }
    return JSON.stringify(
      roundEval(ctx, plan, { rc: Number(args[1] ?? 0), out: log, timedOut: args[2] === '1', maxRuntime: Number(args[3] ?? 2700) }, log),
    );
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
  if (typeof result === 'object') {
    if (result.stdout) process.stdout.write(result.stdout);
    return result.exitCode;
  }
  process.stdout.write(`${result}\n`);
  return 0;
}

// Ein vorab exportiertes STATE_DIR gewinnt -- claude-runner.sh exportiert es,
// damit dieser Prozess exakt dasselbe Verzeichnis sieht wie das Skript.
function stateDir(): string {
  return process.env.STATE_DIR ?? join(here, '..', '..', '.runner');
}

// Slotübergreifend (#204), außerhalb jedes Arbeitsbaums -- claude-runner.sh
// exportiert SHARED_DIR genauso wie STATE_DIR oben.
function sharedDir(): string {
  return process.env.SHARED_DIR ?? join(here, '..', '..', '.shared-runner');
}

// claude-runner.sh exportiert SLOT_ID genauso wie STATE_DIR/SHARED_DIR (#204).
// '1' ist der Default der Ein-Slot-Welt (AK9).
function slotId(): string {
  return process.env.SLOT_ID ?? '1';
}

function defaultContext(): RunnerContext {
  return {
    gh: createGhAdapter(),
    git: createGitAdapter(),
    state: createStateAdapter(stateDir()),
    sharedState: createStateAdapter(sharedDir()),
    claims: createClaimAdapter(join(sharedDir(), 'claims')),
    slotId: slotId(),
    clock: createClock(),
  };
}

// realpathSync auf beiden Seiten normalisiert Symlink-Komponenten (mktemp
// /var -> /private), sonst haelt sich cli.ts ueber einen Symlink-Pfad
// faelschlich fuer ein importiertes Modul (#251). Der undefined-Guard
// schuetzt gegen realpathSync(undefined) (REPL/eingebettet).
const entry = process.argv[1];
const isMain = entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = dispatch(defaultContext(), process.argv.slice(2));
}
