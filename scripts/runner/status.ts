// Statusmeldungen, portiert aus claude-runner.sh (#202, S5 von #184):
// waitingIssues/parkedIssues/parkIssue/queueSnapshot/queueBody.
//
// `status()`/`append_end_reason()` bleiben ABSICHTLICH bash-only: `status()`
// liegt auf dem Fehlerpfad von `ts_run()` selbst (meldet "TS-Naht ausgefallen",
// wenn `tsx` fehlt/kaputt ist). Ein TS-Kern fuer `status()` muesste ueber
// `ts_run()` aufgerufen werden -- genau das erzeugte die in #201 gefixte
// Endlosrekursion (status -> sha1_of -> ts_run -> status -> ...), diesmal
// eine Ebene hoeher (status -> ts_run -> status). Das Risiko steht in keinem
// Verhaeltnis zum Nutzen einer reinen Text-/Hash-Funktion.
import type { GhAdapter } from './gh.js';

// Wartet irgendein Ticket auf den Menschen? Dann ist Gelb die Wahrheit, auch
// wenn der Runner selbst gerade nichts zu tun hat. Der `-q`-Filter laeuft wie
// in der Bash-Vorlage serverseitig in `gh` selbst (liefert direkt "#a, #b"),
// kein eigenes JSON-Parsen noetig.
export function waitingIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'needs-input',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number',
      '-q',
      '[.[].number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// #196: Teilmenge von waitingIssues() mit einer echten offenen Frage (braucht
// eine geschriebene Antwort), fuer den 🟡-Text "wartet auf deine Antwort".
export function answerIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'needs-input',
      '--label',
      'needs-answer',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number',
      '-q',
      '[.[].number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// #196: Teilmenge von waitingIssues() OHNE 'needs-answer' -- reine Freigabe,
// ein Label-Tap genuegt, nichts zu schreiben. Fuer den 🟡-Text "wartet auf
// deine Freigabe".
export function approveIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'needs-input',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number,labels',
      '-q',
      '[.[] | select((.labels | map(.name) | index("needs-answer")) | not) | .number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// Liegt gerade ein 'parked'-Ticket (#145) herum, waehrend an einem anderen
// gebaut wird? Fuer den Status-Text der 🟠-"arbeitet an"-Meldung (#145 AC6).
export function parkedIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'parked',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number',
      '-q',
      '[.[].number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// #196: parkedIssues()-Teilmenge mit 'needs-answer' -- fuer die PARKED_NOTE-
// Zweiteilung "wartet auf deine Antwort" vs. "wartet auf deine Freigabe".
export function parkedAnswerIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'parked',
      '--label',
      'needs-answer',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number',
      '-q',
      '[.[].number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// #196: parkedIssues()-Teilmenge OHNE 'needs-answer' -- reine Freigabe.
export function parkedApproveIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
      '--label',
      'parked',
      '--state',
      'open',
      '--limit',
      '20',
      '--json',
      'number,labels',
      '-q',
      '[.[] | select((.labels | map(.name) | index("needs-answer")) | not) | .number] | map("#" + tostring) | join(", ")',
    ]);
  } catch {
    return '';
  }
}

// Nimmt einem Ticket 'in-progress' ab und gibt 'parked' -- die zentrale
// Stelle fuer die Selbstheilung (#145).
export function parkIssue(issue: number, gh: GhAdapter): boolean {
  try {
    gh.run(['issue', 'edit', String(issue), '--remove-label', 'in-progress', '--add-label', 'parked']);
    return true;
  } catch {
    return false;
  }
}

export interface QueueSnapshotIssue {
  number: number;
  labels: { name: string }[];
  createdAt: string;
}

// Einmaliger Schnappschuss aller offenen Issues mit Labels. Braucht
// 'createdAt', genau wie ROUND_SNAP -- sonst sortiert queueNext() gegen ein
// fehlendes Feld (#149).
export function queueSnapshot(gh: GhAdapter): QueueSnapshotIssue[] {
  let raw = '[]';
  try {
    raw = gh.run(['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,labels,createdAt']);
  } catch {
    return [];
  }
  try {
    return JSON.parse(raw) as QueueSnapshotIssue[];
  } catch {
    return [];
  }
}

// Holt den Queue-Body EINMAL pro Tick (leer, wenn kein QUEUE_ISSUE gesetzt).
export function queueBody(queueIssue: number, gh: GhAdapter): string {
  if (!(queueIssue > 0)) return '';
  try {
    return gh.run(['issue', 'view', String(queueIssue), '--json', 'body', '-q', '.body // ""']);
  } catch {
    return '';
  }
}
