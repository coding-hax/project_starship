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
  // #880: der Entwurfsstatus reist auf demselben `gh pr view` mit, das ohnehin
  // fuer BEHIND/DIRTY geholt wird -- kein zusaetzlicher gh-Aufruf, nur ein Feld
  // mehr in der Liste. Die CI-Wache haengt ihren Riegel daran (nicht mehr ans
  // Label 'check'), damit sie einen Entwurf nie selbst aus dem Entwurf hebt.
  isDraft: boolean;
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
    raw = gh.run(['pr', 'view', pr, '--json', 'headRefName,mergeStateStatus,isDraft']);
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

export interface PrCiEvaluation {
  state: PrState;
  // #1174 (AC5): rote Checks, die 'main' NICHT verlangt und die die
  // Entscheidung deshalb nicht mehr beeinflusst haben. Sie verschwinden nicht
  // lautlos, sondern werden benannt weitergereicht -- sonst tauschen wir die
  // Schleife gegen Schweigen.
  ignoredFailing: string[];
}

// #1174: Welche Checks GitHub fuer 'main' wirklich verlangt. Diese Liste ist
// die Antwort, die der Mensch auf "darf gemergt werden?" laengst gegeben hat.
// Der Runner hat sie bisher ueberstimmt und JEDEN roten Check als CI-Fehler
// gewertet -- auch einen fremden (Vercel `build-rate-limit`, #1127/#1016).
// Ergebnis war eine Endlosschleife: 'check' ab, Rolle zurueck auf 'build', der
// Bau-Lauf findet an einem fremden Rate-Limit nichts zu reparieren, setzt
// 'check' wieder, naechster Takt raeumt es erneut ab (#1127: sieben Runden in
// acht Stunden, kuerzester Zyklus 23 Sekunden).
//
// Rueckgabe `null` heisst "nicht ermittelbar" (Netz weg, Token ohne Recht,
// kaputte Antwort) -- NICHT "nichts ist required". Der Aufrufer faellt dann
// auf das alte Verhalten zurueck (AC4). Aus demselben Grund ist auch eine
// LEERE contexts-Liste `null`: sie waere sonst ein Freibrief, jeden roten
// Check zu ignorieren.
//
// Blind fuer Checks, die ueber *Rulesets* statt Branch-Schutz verlangt werden
// -- dieses Repo hat keine (`gh api repos/:owner/:repo/rulesets` ist leer).
// Kaeme je eines dazu, faellt diese Funktion auf die Branch-Schutz-Liste
// zurueck; der Runner waere dann zu streng, nie zu grosszuegig.
export function requiredCheckContexts(gh: GhAdapter): string[] | null {
  let raw = '';
  try {
    raw = gh.run(['api', 'repos/:owner/:repo/branches/main/protection/required_status_checks']);
  } catch {
    return null;
  }
  const contexts = tryParseJson<{ contexts?: unknown }>(raw)?.contexts;
  if (!Array.isArray(contexts)) return null;
  const names = contexts.filter((c): c is string => typeof c === 'string');
  return names.length > 0 ? names : null;
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
//
// #1174: 'pending' und 'fail'/'cancel' zaehlen nur noch, wenn GitHub den Check
// fuer 'main' auch verlangt. Ein fremder roter Check haelt die Flotte damit
// nicht mehr an -- er wird aber benannt weitergereicht, nicht verschwiegen.
export function prCiEvaluation(pr: string, gh: GhAdapter): PrCiEvaluation {
  const checks = prChecks(pr, gh);
  if (checks.length === 0) return { state: 'pending', ignoredFailing: [] };

  const isRed = (c: PrCheck) => c.bucket === 'fail' || c.bucket === 'cancel';
  // Die Required-Liste kostet einen `gh api`-Aufruf. Sie wird nur geholt, wenn
  // sie das Ergebnis ueberhaupt aendern KANN -- ist ohnehin nichts rot und
  // nichts pending, bleibt ein gruener PR genauso teuer wie vor #1174.
  const relevant = checks.some((c) => isRed(c) || c.bucket === 'pending');
  const required = relevant ? requiredCheckContexts(gh) : null;
  // AC4: `null` heisst "nicht ermittelbar" -- dann zaehlt wie frueher JEDER
  // Check. Nie "nichts ist required".
  const counts = (c: PrCheck) => required === null || required.includes(c.name);
  const ignoredFailing = required === null ? [] : checks.filter((c) => isRed(c) && !counts(c)).map((c) => c.name);

  if (checks.some((c) => c.bucket === 'pending' && counts(c))) return { state: 'pending', ignoredFailing };
  // Ein verlangter Check, der in der Liste des PR ueberhaupt nicht auftaucht,
  // hat noch nicht gemeldet -- das ist 'pending', nicht 'gruen'. Ohne diese
  // Zeile koennte ein PR, an dem allein ein fremder Check haengt, gemergt
  // werden, BEVOR die verlangten Checks auch nur gestartet sind. Das ist genau
  // die Luecke, die das Filtern der 'pending'-Buckets sonst aufreisst.
  if (required !== null && required.some((name) => !checks.some((c) => c.name === name))) {
    return { state: 'pending', ignoredFailing };
  }
  if (checks.some((c) => isRed(c) && counts(c))) return { state: 'failing', ignoredFailing };
  // #880: EIN `prMergeState` fuer DIRTY UND BEHIND statt zweier (`prIsDirty`
  // dann `prIsBehind`) -- so bleibt die Zahl der `gh pr view`-Aufrufe gleich,
  // wenn `resolveWatchState` fuer den Entwurfsstatus denselben Aufruf noch
  // einmal spricht. Die Reihenfolge (DIRTY vor BEHIND) ist unveraendert.
  const status = prMergeState(pr, gh)?.mergeStateStatus;
  if (status === 'DIRTY') return { state: 'conflict', ignoredFailing };
  if (status === 'BEHIND') return { state: 'behind', ignoredFailing };
  return { state: 'success', ignoredFailing };
}

// Nur der Zustand, ohne die Liste der ignorierten roten Checks -- fuer die
// CLI (`pr-ci-state`) und alles, was die Sichtbarkeitsspur nicht braucht.
export function prCiState(pr: string, gh: GhAdapter): PrState {
  return prCiEvaluation(pr, gh).state;
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

    // #531: Der 'pr list'-Schnappschuss oben ist T0, dieser Punkt hier ist
    // T1 > T0 -- ein Auto-Merge-PR kann sich in der Zwischenzeit selbst
    // gemergt und damit sein eigenes 'Closes #N' bereits eingeloest haben.
    // Nur ein *live* noch offener PR traegt die Invariante des Waechters
    // ("ein offener PR mit Closes #N kann #N nicht geschlossen haben").
    // Scheitert die Abfrage, wird bewusst NICHT reopnt (Fail-safe: ein
    // faelschliches Reopen ist teurer als ein ausgelassenes -- die naechste
    // Runde prueft ohnehin erneut).
    let prState = '';
    try {
      prState = gh.run(['pr', 'view', String(item.number), '--json', 'state', '-q', '.state']).trim();
    } catch {
      prState = '';
    }
    if (prState !== 'OPEN') continue;

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

const MAX_FAILING_CHECKS = 3;
const MAX_LOG_LINES = 25;
const MAX_LINE_BYTES = 1024;
const MAX_SUMMARY_BYTES = 8192;
const LINE_TRUNCATION_MARK = ' …[Zeile gekürzt]';
const OUTPUT_TRUNCATION_MARK = '\n\n_… Ausgabe gekürzt, überschritt 8.192 Bytes._';

// Schneidet an einer UTF-8-Zeichengrenze ab, nie mitten in einem Mehrbyte-
// Zeichen -- eine Byte-Grenze allein koennte eine kaputte Sequenz erzeugen.
function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(str, 'utf-8');
  if (buf.byteLength <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0b11000000) === 0b10000000) end--;
  return buf.subarray(0, end).toString('utf-8');
}

function truncateLineToBytes(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf-8') <= maxBytes) return line;
  const markBytes = Buffer.byteLength(LINE_TRUNCATION_MARK, 'utf-8');
  return `${truncateUtf8Bytes(line, maxBytes - markBytes)}${LINE_TRUNCATION_MARK}`;
}

// Ordnet die Zeilen eines `--log-failed`-Logs einem Job zu: jede Zeile
// beginnt mit `<Jobname>\t<Schrittname>\t...` (mehrere Jobs eines Laufs
// stehen im selben Log). Kein exakter Treffer -- z.B. bei wiederverwendbaren
// Workflows kann der Job anders heissen als der Check --, dann Zeilen nehmen,
// deren Job-Feld den Checknamen enthaelt oder umgekehrt.
function jobLogLines(log: string, checkName: string): string[] {
  const lines = log.split('\n');
  const exact = lines.filter((line) => line.split('\t', 1)[0] === checkName);
  if (exact.length > 0) return exact;
  return lines.filter((line) => {
    const job = line.split('\t', 1)[0];
    return job.length > 0 && (job.includes(checkName) || checkName.includes(job));
  });
}

// Knappe Zusammenfassung der roten Checks fuer den Fix-Agenten-Auftrag: Job,
// Kurzbeschreibung, Link und ein begrenzter Log-Ausschnitt. Hoechstens die
// ersten 3 roten Checks, sonst waechst der Auftrag mit jedem zusaetzlichen
// Shard unnoetig. Mehrere Checks (z.B. Shards) EINES Workflow-Laufs teilen
// sich dieselbe runId -- der Log wird darum je runId genau einmal geholt
// (#1141) und je Check anhand des Job-Namens wieder auseinandersortiert.
export function prFailureSummary(pr: string, gh: GhAdapter): string {
  const checks = prChecks(pr, gh);
  const allFailing = checks
    // #283: Hier stand eine Ausnahme fuer 'protected-paths' -- der Check war
    // eine Genehmigungs-Schranke, kein Fund, den ein Agent haette beheben
    // koennen. Den Job gibt es nicht mehr, also auch die Ausnahme nicht.
    .filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const failing = allFailing.slice(0, MAX_FAILING_CHECKS);
  const omittedChecks = allFailing.length - failing.length;

  // Log je runId nur EINMAL holen, unabhaengig davon, wie viele der
  // gemeldeten Checks dieselbe runId teilen. `null` markiert einen
  // gescheiterten Abruf, gesondert von einem leeren, aber erfolgreichen Log.
  const logsByRunId = new Map<string, string | null>();
  for (const c of failing) {
    const runId = c.link?.match(/runs\/(\d+)/)?.[1];
    if (!runId || logsByRunId.has(runId)) continue;
    try {
      logsByRunId.set(runId, gh.run(['run', 'view', runId, '--log-failed']));
    } catch {
      logsByRunId.set(runId, null);
    }
  }

  const parts: string[] = [];
  for (const c of failing) {
    parts.push(`### ${c.name}\n${c.description ?? ''}${c.link ? `\n${c.link}` : ''}\n`);
    const runId = c.link?.match(/runs\/(\d+)/)?.[1];
    if (!runId) continue;
    const log = logsByRunId.get(runId);
    if (log === null) {
      parts.push('_Log nicht abrufbar._\n');
      continue;
    }
    if (!log) continue;
    const tail = jobLogLines(log, c.name)
      .slice(-MAX_LOG_LINES)
      .map((line) => truncateLineToBytes(line, MAX_LINE_BYTES));
    if (tail.length === 0) continue;
    parts.push(`\`\`\`\n${tail.join('\n')}\n\`\`\`\n`);
  }

  // Bash faengt jeden Aufruf ueber `$(...)` ab (summary=$(pr_failure_summary
  // ...) in watch_running_issue_bash) -- das entfernt trailing Newlines
  // unvermeidlich. Hier explizit angleichen, sonst weicht das direkt in
  // watchRunningIssue() eingebettete Ergebnis (kein Subshell-Grenze in TS)
  // davon ab.
  let result = parts.join('').replace(/\n+$/, '');
  if (omittedChecks > 0) {
    result += `\n\n_… ${omittedChecks} weitere(r) roter Check(s) gekürzt._`;
  }

  if (Buffer.byteLength(result, 'utf-8') > MAX_SUMMARY_BYTES) {
    const markBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARK, 'utf-8');
    result = truncateUtf8Bytes(result, MAX_SUMMARY_BYTES - markBytes) + OUTPUT_TRUNCATION_MARK;
  }

  return result;
}
