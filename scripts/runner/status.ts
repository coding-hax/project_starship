// Statusmeldungen, portiert aus claude-runner.sh (#202, S5 von #184):
// waitingIssues/parkedIssues/parkIssue/queueSnapshot. `queueBody()` (Body des
// angepinnten Queue-Issues) ist mit #725 (S2 von ADR-0023) ersatzlos weg --
// der Rang ist jetzt das Label `next` an den Tickets selbst.
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
//
// #272: 'needs-answer' ist seit S2b das EINZIGE Wartelabel. Vorher gab es eine
// Klammer ('needs-input') und einen Marker daneben ('needs-answer'), und die
// Klammer bedeutete zweierlei: "beantworte meine Frage" und "setz mir
// human-approved". Der zweite Fall ist mit #276 verschwunden -- damit bleibt
// genau ein Wartezustand, und er heisst, was er ist. Entsprechend gibt es hier
// keine answerIssues()/approveIssues()-Aufteilung mehr.
//
// 'parked' ist ersatzlos weg (#272): ein wartendes Ticket behaelt einfach
// 'in-progress'. Die Auswahl ueberspringt es wegen 'needs-answer', belegt also
// keinen Bauplatz -- und setzt die Arbeit ueber denselben 'running'-Zweig fort,
// sobald das Label faellt. parkIssue()/parkedIssues() entfallen damit.
export function waitingIssues(gh: GhAdapter): string {
  try {
    return gh.run([
      'issue',
      'list',
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

export interface QueueSnapshotIssue {
  number: number;
  labels: { name: string }[];
  createdAt: string;
  /** Fuer entriesFromIssues() (#724) -- Ketten aus 'Nach:'-Zeilen im Ticket-Body. */
  body?: string;
}

// Einmaliger Schnappschuss aller offenen Issues mit Labels. Braucht
// 'createdAt', genau wie ROUND_SNAP -- sonst sortiert queueNext() gegen ein
// fehlendes Feld (#149). Braucht seit #724 auch 'body' -- sonst saehe die
// Anzeige (queueNext) einen anderen Abhaengigkeitsgraphen als die echte
// Auswahl (pickTicket in round.ts, die den vollen ROUND_SNAP-Body schon hat).
export function queueSnapshot(gh: GhAdapter): QueueSnapshotIssue[] {
  let raw = '[]';
  try {
    raw = gh.run(['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,labels,createdAt,body']);
  } catch {
    return [];
  }
  try {
    return JSON.parse(raw) as QueueSnapshotIssue[];
  } catch {
    return [];
  }
}
