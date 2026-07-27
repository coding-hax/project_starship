// PR-Zustandslogik, portiert aus claude-runner.sh (#201, S4 von #184).
// GitHub-Zugriff ausschliesslich ueber den `gh`-Adapter, kein `jq` -- JSON
// kommt direkt von `gh --json` und wird mit `JSON.parse` gelesen. Jeder
// gh-Aufruf ist einzeln try/catch-umschlossen, analog zum `2>/dev/null` auf
// der Bash-Seite: ein fehlgeschlagener Aufruf ist ein leeres/negatives
// Ergebnis, nie ein geworfener Fehler.
import type { GhAdapter } from './gh.js';

export type PrState = 'pending' | 'failing' | 'conflict' | 'behind' | 'success';

interface PrListItem {
  number: number;
  headRefName: string;
}

interface PrCheck {
  bucket: string;
  name: string;
  description?: string;
  link?: string;
}

export interface PrMergeStateInfo {
  headRefName: string;
  mergeStateStatus: string;
}

function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Offener PR zu einem Ticket, gefunden ueber die Branch-Konvention
// (feat|fix|chore/<nr>-<slug>) -- keine Textsuche im Titel noetig.
export function prForIssue(issue: number, gh: GhAdapter): string {
  let raw = '';
  try {
    raw = gh.run(['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,headRefName']);
  } catch {
    return '';
  }
  const list = tryParseJson<PrListItem[]>(raw) ?? [];
  const pattern = new RegExp(`^(feat|fix|chore)/${issue}-`);
  const match = list.find((pr) => pattern.test(pr.headRefName));
  return match ? String(match.number) : '';
}

// GitHub berechnet mergeStateStatus serverseitig -- BEHIND heisst: der
// PR-Branch hat Commits von 'main' noch nicht.
export function prMergeState(pr: string, gh: GhAdapter): PrMergeStateInfo | null {
  let raw = '';
  try {
    raw = gh.run(['pr', 'view', pr, '--json', 'headRefName,mergeStateStatus']);
  } catch {
    return null;
  }
  return tryParseJson<PrMergeStateInfo>(raw);
}

export function prIsBehind(pr: string, gh: GhAdapter): boolean {
  return prMergeState(pr, gh)?.mergeStateStatus === 'BEHIND';
}

// DIRTY heisst: GitHub kann den PR nicht mehr automatisch mit 'main' mergen,
// ein echter Konflikt liegt vor. Anders als BEHIND gewinnt DIRTY dauerhaft --
// sobald ein Konflikt besteht, meldet GitHub NIE mehr BEHIND fuer diesen PR
// (#217).
export function prIsDirty(pr: string, gh: GhAdapter): boolean {
  return prMergeState(pr, gh)?.mergeStateStatus === 'DIRTY';
}

function prChecks(pr: string, gh: GhAdapter): PrCheck[] {
  let raw = '';
  try {
    raw = gh.run(['pr', 'checks', pr, '--json', 'bucket,name,description,link']);
  } catch {
    return [];
  }
  return tryParseJson<PrCheck[]>(raw) ?? [];
}

// CI-Gesamtzustand eines PR. Reihenfolge ist Absicht (#160, erweitert um
// #217): 'pending' hat Vorrang vor 'failing' -- ein noch laufender Shard darf
// einen bereits roten Check nicht uebertoenen. 'conflict' (mergeStateStatus
// DIRTY) wird VOR 'behind' geprueft, weil GitHub bei einem echten
// Merge-Konflikt niemals mehr 'BEHIND' meldet -- ohne diese Reihenfolge waere
// 'behind' fuer einen solchen PR fuer immer unerreichbar und der
// Konfliktpfad toter Code. Ohne 'conflict' fiele ein DIRTY-PR mit gruenen
// Checks sogar auf 'success' durch, und der Runner wuerde ihn Takt fuer Takt
// vergeblich zu mergen versuchen. 'behind' wird erst geprueft, NACHDEM
// feststeht, dass nichts mehr laeuft, nichts rot ist und kein echter Konflikt
// vorliegt.
export function prCiState(pr: string, gh: GhAdapter): PrState {
  const checks = prChecks(pr, gh);
  if (checks.length === 0) return 'pending';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failing';
  if (prIsDirty(pr, gh)) return 'conflict';
  if (prIsBehind(pr, gh)) return 'behind';
  return 'success';
}

// Squash-Merge mit EIGENEM Subject/Body statt GitHub die Commit-Historie
// sammeln zu lassen (#172): ohne --subject/--body haengt GitHub beim Squash
// alle Commit-Nachrichten des Branches aneinander -- inklusive fremder
// 'Closes #N' aus Merge-Commits, die beim Nachziehen von 'main' mitgezogen
// wurden.
// Rueckgabewert (#217 AC4): true = Merge bzw. Auto-Merge tatsaechlich
// aktiviert, false = 'gh pr merge' ist gescheitert. Der Aufrufer entscheidet
// damit, ob 'needs-answer' ueberhaupt entfernt werden duerfen -- sonst
// faellt das Ticket aus jeder Wache heraus, waehrend der PR offen und
// unbeobachtet liegen bleibt.
export function prSquashMerge(pr: string, gh: GhAdapter): boolean {
  let title = '';
  try {
    title = gh.run(['pr', 'view', pr, '--json', 'title', '-q', '.title']).trim();
  } catch {
    title = '';
  }
  try {
    if (title) {
      gh.run(['pr', 'merge', '--squash', '--auto', '--delete-branch', '--subject', title, '--body', '', pr]);
    } else {
      gh.run(['pr', 'merge', '--squash', '--auto', '--delete-branch', pr]);
    }
    return true;
  } catch {
    return false;
  }
}

// Netz (#172, Plan B): traegt ein offener PR 'Closes #N' im Titel, aber
// Issue #N ist schon geschlossen, kann DIESER PR es nicht geschlossen haben
// -- das Ticket wird wieder geoeffnet, der Grund als Kommentar vermerkt.
export function reopenFalselyClosedIssues(gh: GhAdapter): void {
  let raw = '[]';
  try {
    raw = gh.run(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title']);
  } catch {
    raw = '[]';
  }
  const list = tryParseJson<{ number: number; title: string }[]>(raw) ?? [];
  const closesRe = /[Cc]loses #(\d+)/;

  for (const item of list) {
    // Defensiv: ein PR ohne Titel im Ergebnis darf diesen Wächter nicht
    // werfen lassen. Seit S6 (#203) gibt es keinen Bash-Rückfallpfad mehr --
    // eine Ausnahme hier beendet den tsx-Prozess und damit die ganze Runde.
    const match = item.title?.match(closesRe);
    if (!match) continue;
    const issue = match[1];

    let state = '';
    try {
      state = gh.run(['issue', 'view', issue, '--json', 'state', '-q', '.state']).trim();
    } catch {
      state = '';
    }
    if (state !== 'CLOSED') continue;

    try {
      gh.run(['issue', 'reopen', issue]);
    } catch {
      // best effort
    }
    try {
      gh.run([
        'issue',
        'comment',
        issue,
        '--body',
        `🔁 Automatisch wieder geöffnet: Dieses Ticket war geschlossen, obwohl PR #${item.number} (\`Closes #${issue}\`) noch offen ist — kann also nicht der Schließer gewesen sein. Vermutlich hat ein Squash-Merge eines anderen PR ein fremdes \`Closes #${issue}\` aus einem mitgezogenen Commit gelesen (#172). Der Bau macht hier normal weiter.`,
      ]);
    } catch {
      // best effort
    }
  }
}

// Knappe Zusammenfassung der roten Checks fuer den Fix-Agenten-Auftrag:
// Job, Kurzbeschreibung, ein begrenzter Log-Ausschnitt. Hoechstens die
// ersten 3 roten Checks, sonst waechst der Auftrag mit jedem zusaetzlichen
// Shard unnoetig.
export function prFailureSummary(pr: string, gh: GhAdapter): string {
  const checks = prChecks(pr, gh);
  const failing = checks
    // #283: Hier stand eine Ausnahme fuer 'protected-paths' -- der Check war
    // eine Genehmigungs-Schranke, kein Fund, den ein Agent haette beheben
    // koennen. Den Job gibt es nicht mehr, also auch die Ausnahme nicht.
    .filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
    .slice(0, 3);

  const parts: string[] = [];
  for (const c of failing) {
    parts.push(`### ${c.name}\n${c.description ?? ''}\n`);
    const runId = c.link?.match(/runs\/(\d+)/)?.[1];
    if (!runId) continue;
    let log = '';
    try {
      log = gh.run(['run', 'view', runId, '--log-failed']);
    } catch {
      log = '';
    }
    if (!log) continue;
    const tail = log.split('\n').slice(-25).join('\n');
    parts.push(`\`\`\`\n${tail}\n\`\`\`\n`);
  }
  // Bash faengt jeden Aufruf ueber `$(...)` ab (summary=$(pr_failure_summary
  // ...) in watch_running_issue_bash) -- das entfernt trailing Newlines
  // unvermeidlich. Hier explizit angleichen, sonst weicht das direkt in
  // watchRunningIssue() eingebettete Ergebnis (kein Subshell-Grenze in TS) von
  // der Bash-Parität ab, siehe runner-ts-s5-parity.test.sh.
  return parts.join('').replace(/\n+$/, '');
}
