// PR-Zustandslogik, portiert aus claude-runner.sh (#201, S4 von #184).
// GitHub-Zugriff ausschliesslich ueber den `gh`-Adapter, kein `jq` -- JSON
// kommt direkt von `gh --json` und wird mit `JSON.parse` gelesen. Jeder
// gh-Aufruf ist einzeln try/catch-umschlossen, analog zum `2>/dev/null` auf
// der Bash-Seite: ein fehlgeschlagener Aufruf ist ein leeres/negatives
// Ergebnis, nie ein geworfener Fehler.
import type { GhAdapter } from './gh.js';

export type PrState = 'pending' | 'failing' | 'behind' | 'success';

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

function prChecks(pr: string, gh: GhAdapter): PrCheck[] {
  let raw = '';
  try {
    raw = gh.run(['pr', 'checks', pr, '--json', 'bucket,name,description,link']);
  } catch {
    return [];
  }
  return tryParseJson<PrCheck[]>(raw) ?? [];
}

// CI-Gesamtzustand eines PR. Reihenfolge ist Absicht (#160): 'pending' hat
// Vorrang vor 'failing' -- ein noch laufender Shard darf einen bereits roten
// Check nicht uebertoenen. 'behind' wird erst geprueft, NACHDEM feststeht,
// dass nichts mehr laeuft und nichts rot ist.
export function prCiState(pr: string, gh: GhAdapter): PrState {
  const checks = prChecks(pr, gh);
  if (checks.length === 0) return 'pending';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failing';
  if (prIsBehind(pr, gh)) return 'behind';
  return 'success';
}

// Sind ALLE roten Checks genau 'protected-paths'? Dann ist das kein Fund fuer
// einen Fix-Agenten, sondern die vorgesehene Genehmigungs-Schranke.
export function prOnlyProtectedPathsRed(pr: string, gh: GhAdapter): boolean {
  const checks = prChecks(pr, gh);
  return !checks.some((c) => (c.bucket === 'fail' || c.bucket === 'cancel') && c.name !== 'protected-paths');
}

// Squash-Merge mit EIGENEM Subject/Body statt GitHub die Commit-Historie
// sammeln zu lassen (#172): ohne --subject/--body haengt GitHub beim Squash
// alle Commit-Nachrichten des Branches aneinander -- inklusive fremder
// 'Closes #N' aus Merge-Commits, die beim Nachziehen von 'main' mitgezogen
// wurden.
export function prSquashMerge(pr: string, gh: GhAdapter): void {
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
  } catch {
    // best effort, wie >/dev/null 2>&1 auf der Bash-Seite.
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
    const match = item.title.match(closesRe);
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
    .filter((c) => (c.bucket === 'fail' || c.bucket === 'cancel') && c.name !== 'protected-paths')
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
  return parts.join('');
}
