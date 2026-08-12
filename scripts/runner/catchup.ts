// Nachzieh-Logik fuer zurueckgefallene PR-Branches, portiert aus
// claude-runner.sh (#201, S4 von #184). `prCatchUpBehind` bildet exakt den
// fetch/checkout/merge/push-Ablauf von `pr_catch_up_behind()` nach --
// Rueckgabewert ist eine discriminated union statt der Zahlen-Exitcodes 0-5,
// an der CLI-Kante (cli.ts) wird wieder darauf abgebildet, solange
// Bash-Aufrufer existieren.
import type { GhAdapter } from './gh.js';
import type { GitAdapter } from './git.js';
import type { StateAdapter } from './state.js';
import { prMergeState } from './pr.js';

export type CatchupResult =
  | { kind: 'ok' }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'fetchFailed' }
  | { kind: 'checkoutFailed' }
  | { kind: 'pushFailed' };

// Entspricht dem Zahlen-Exitcode der Bash-Implementierung -- 0 nachgezogen,
// 1 Konflikt, 2 unsauberer Arbeitsbaum, 3 fetch/Metadaten, 4 checkout, 5 push.
export function catchupExitCode(result: CatchupResult): number {
  switch (result.kind) {
    case 'ok':
      return 0;
    case 'conflict':
      return 1;
    case 'dirty':
      return 2;
    case 'fetchFailed':
      return 3;
    case 'checkoutFailed':
      return 4;
    case 'pushFailed':
      return 5;
  }
}

// stdout-Gegenstueck der Bash-Implementierung: Konfliktdateien bzw.
// stoerende Pfade kommagetrennt, sonst leer.
export function catchupStdout(result: CatchupResult): string {
  if (result.kind === 'conflict') return result.files.join(',');
  if (result.kind === 'dirty') return result.paths.join(',');
  return '';
}

function linesOf(raw: string): string[] {
  return raw.split('\n').filter((line) => line.length > 0);
}

function checkoutBack(cur: string, git: GitAdapter): void {
  try {
    git.run(['checkout', cur, '--quiet']);
  } catch {
    // best effort, wie auf der Bash-Seite -- der Rueckgabewert zaehlt hier nicht.
  }
}

// Ermittelt den Worktree, der `branch` aktuell haelt (#665, Ansatz A): Catch-up
// muss DORT laufen, nicht im Prozess-cwd -- sonst bewegt `checkout -B` den Ref
// unter einem Worktree weg, dessen Index/Arbeitsbaum nicht folgen (invertierter
// Index, siehe Issue). `undefined` heisst: kein Worktree haelt den Branch, der
// Fallback-Pfad (heutiges Verhalten) greift.
export function worktreeHoldingBranch(branch: string, git: GitAdapter): string | undefined {
  if (!branch) return undefined;
  let raw = '';
  try {
    raw = git.run(['worktree', 'list', '--porcelain']);
  } catch {
    return undefined;
  }
  let current: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line === `branch refs/heads/${branch}`) {
      return current;
    }
  }
  return undefined;
}

// AK3: vergleicht den gestagten Index eines Worktrees gegen seinen HEAD-Baum.
// Ungleich heisst invertierter Index -- der Vorfallstyp aus CLAUDE.mds
// "geladene Waffe", ein Bau-Lauf dort wuerde den Revert mitcommitten. Bewusst
// NUR Index<->HEAD (nicht "status leer"): unstaged Arbeit hat
// write-tree === HEAD^{tree} und loest keinen Fehlalarm aus.
export function worktreeIndexOk(dir: string, git: GitAdapter): { ok: boolean; reason: string } {
  let indexTree = '';
  try {
    indexTree = git.run(['write-tree'], dir);
  } catch {
    return { ok: false, reason: 'write-tree fehlgeschlagen' };
  }
  let headTree = '';
  try {
    headTree = git.run(['rev-parse', 'HEAD^{tree}'], dir);
  } catch {
    return { ok: false, reason: 'HEAD^{tree} nicht lesbar' };
  }
  if (indexTree !== headTree) {
    return { ok: false, reason: `Index (${indexTree}) weicht vom HEAD-Baum (${headTree}) ab` };
  }
  return { ok: true, reason: '' };
}

// Merge + Push direkt im Worktree, der den Branch haelt -- kein `checkout -B`
// noetig, der Branch ist dort schon ausgecheckt (#665 Ansatz A). Scheitert der
// Merge an einem echten Konflikt: kein Commit, Merge wird abgebrochen; der
// Worktree bleibt bewusst auf seinem Branch (kein checkoutBack -- anders als
// im Fallback gibt es hier keinen "vorherigen Branch" im selben Checkout).
function mergeAndPushInWorktree(worktree: string, branch: string, git: GitAdapter): CatchupResult {
  try {
    git.run(['merge', 'origin/main', '--no-edit', '--quiet'], worktree);
  } catch {
    let conflictsRaw = '';
    try {
      conflictsRaw = git.run(['diff', '--name-only', '--diff-filter=U'], worktree);
    } catch {
      conflictsRaw = '';
    }
    try {
      git.run(['merge', '--abort'], worktree);
    } catch {
      // best effort
    }
    return { kind: 'conflict', files: linesOf(conflictsRaw) };
  }

  try {
    git.run(['push', 'origin', `HEAD:${branch}`, '--quiet'], worktree);
  } catch {
    return { kind: 'pushFailed' };
  }
  return { kind: 'ok' };
}

// Fallback ohne Worktree: heutiger Ablauf unveraendert, jeder Aufruf OHNE
// cwd-Arg (#665) -- laeuft im Prozess-cwd wie vor diesem Ticket.
function catchUpViaCheckout(branch: string, git: GitAdapter): CatchupResult {
  let cur = '';
  try {
    cur = git.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    cur = '';
  }
  if (!cur || cur === 'HEAD') cur = 'main';

  try {
    git.run(['checkout', '-B', branch, `origin/${branch}`, '--quiet']);
  } catch {
    return { kind: 'checkoutFailed' };
  }

  try {
    git.run(['merge', 'origin/main', '--no-edit', '--quiet']);
  } catch {
    let conflictsRaw = '';
    try {
      conflictsRaw = git.run(['diff', '--name-only', '--diff-filter=U']);
    } catch {
      conflictsRaw = '';
    }
    try {
      git.run(['merge', '--abort']);
    } catch {
      // best effort
    }
    checkoutBack(cur, git);
    return { kind: 'conflict', files: linesOf(conflictsRaw) };
  }

  try {
    git.run(['push', 'origin', `HEAD:${branch}`, '--quiet']);
  } catch {
    checkoutBack(cur, git);
    return { kind: 'pushFailed' };
  }
  checkoutBack(cur, git);
  return { kind: 'ok' };
}

// Zieht 'main' per git in einen zurueckgefallenen PR-Branch: fetch + merge +
// push -- bewusst ueber git, nicht 'gh pr update-branch' (#160). Erwartet
// einen sauberen Arbeitsbaum; ein dreckiger Baum wird konservativ als Fehler
// behandelt, statt riskant drueberzumergen oder ihn per 'git stash'/'--force'
// selbst wegzuraeumen (#171) -- was dort liegt kann unersetzlich sein.
//
// #665: haelt ein Worktree den Branch, laeuft der ganze Ablauf DORT (Ansatz
// A) statt im Prozess-cwd -- sonst bewacht der Dirty-Guard das falsche
// Verzeichnis und `checkout -B` bewegt den Ref unter dem Worktree weg.
export function prCatchUpBehind(pr: string, git: GitAdapter, gh: GhAdapter): CatchupResult {
  const branch = prMergeState(pr, gh)?.headRefName ?? '';
  if (!branch) return { kind: 'fetchFailed' };

  const worktree = worktreeHoldingBranch(branch, git);

  let statusOut = '';
  try {
    statusOut = git.run(['status', '--porcelain'], worktree);
  } catch {
    statusOut = '';
  }
  const dirtyLines = linesOf(statusOut);
  if (dirtyLines.length > 0) {
    const paths = dirtyLines.slice(0, 5).map((line) => line.slice(3));
    return { kind: 'dirty', paths };
  }

  try {
    git.run(['fetch', 'origin', 'main', branch, '--quiet'], worktree);
  } catch {
    return { kind: 'fetchFailed' };
  }

  return worktree ? mergeAndPushInWorktree(worktree, branch, git) : catchUpViaCheckout(branch, git);
}

// Klartext-Ursache je Nicht-Konflikt-Rueckgabewert von prCatchUpBehind
// (#171 AC1/AC2), fuers Statusticket UND fuers Wiederholungs-Tracking unten.
export function catchupFailReason(code: number): string {
  switch (code) {
    case 2:
      return 'unsauberer Arbeitsbaum';
    case 3:
      return 'fetch fehlgeschlagen (PR-Metadaten oder `git fetch`)';
    case 4:
      return 'checkout fehlgeschlagen';
    case 5:
      return 'push fehlgeschlagen';
    default:
      return 'unbekannter Fehler';
  }
}

// Zaehlt aufeinanderfolgende Nachzieh-Fehlschlaege je Ticket UND Ursache
// dateibasiert unter $STATE_DIR (#171 AC3, analog failcount). Wechselt die
// Ursache oder gab es zuletzt einen Erfolg/Konflikt (catchupFailReset),
// beginnt die Zaehlung wieder bei 1. Ab der DRITTEN Runde in Folge mit
// derselben Ursache: 'eskaliert' (Status soll 🟡 zeigen).
export function catchupFailEscalated(issue: number, reason: string, state: StateAdapter): boolean {
  const key = `catchup-fail-${issue}`;
  const raw = state.read(key);
  let prevReason = '';
  let prevCount = 0;
  if (raw) {
    const lines = raw.split('\n');
    prevReason = lines[0] ?? '';
    prevCount = Number(lines[1]) || 0;
  }
  const count = prevReason === reason ? prevCount + 1 : 1;
  state.write(key, `${reason}\n${count}\n`);
  return count >= 3;
}

// Nach einem erfolgreichen Nachziehen oder einem echten Konflikt (eigener,
// schon sichtbarer Fund) faengt die Wiederholungs-Zaehlung wieder bei null an.
export function catchupFailReset(issue: number, state: StateAdapter): void {
  state.remove(`catchup-fail-${issue}`);
}
