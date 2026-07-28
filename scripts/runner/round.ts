// Eine Runde des Runner-Takts, portiert aus `run_round()` in
// claude-runner.sh (#203, S6 von #184).
//
// Die Runde zerfaellt an genau EINER Stelle: dem `claude`-Aufruf. Der bleibt
// in Bash (AK6/AK7), weil `run_limited` an Signalen und Prozessgruppen haengt
// -- in Node waere das ein Rueckschritt. Daraus ergibt sich das Protokoll:
//
//   1. roundPlan()  -- alles VOR dem Aufruf: Waechter, Ticketwahl, CI-Wache,
//                      Modell, Deckel, Prompt. Liefert entweder 'done' (die
//                      Runde ist ohne Agentenlauf zu Ende) oder 'run'.
//   2. Bash         -- `run_limited $timeout claude ...`, Prompt ueber stdin.
//   3. roundEval()  -- alles NACH dem Aufruf: Session-ID, Read-only-Netz,
//                      Limit/Notbremse/Transient/Fehlschlag, Chain-Entscheid.
//
// Die menschenlesbaren Statustexte entstehen hier, werden aber von Bash
// geschrieben (`status()`): so bleibt der Status-Hash an einer Stelle, und
// die Bash-Suiten beobachten den Runner weiterhin dort, wo sie es immer
// getan haben.
import type { Clock } from './clock.js';
import type { GhAdapter } from './gh.js';
import type { GitAdapter } from './git.js';
import type { StateAdapter } from './state.js';
import type { ClaimAdapter } from './claim.js';
import { claimSweep, claimTake, claimedElsewhere } from './claim.js';
import type { QueueIssue } from './queue.js';
import { queueBlocked, queueCycles, queueDone, queueEntries, queuePending } from './queue.js';
import { queueBody, queueSnapshot, waitingIssues } from './status.js';
import { pickTicket, queueNext, type RunRole } from './select.js';
import { watchWaitingIssues, watchRunningIssue, type WaitingIssueInput } from './watch.js';
import { prForIssue, reopenFalselyClosedIssues } from './pr.js';
import { tierCurrent, tierFromLabels } from './tier.js';
import { buildEscalationEval, resumeAllowed } from './escalation.js';
import { opusBuildCapReached, opusBuildCapReserve } from './cap.js';
import { fmtHm, resetEpoch } from './time.js';
import {
  BUILD_TOOLS,
  READONLY_DENY,
  READONLY_TOOLS,
  buildPrompt,
  ciFixPrompt,
  planPrompt,
  researchPrompt,
} from './prompts.js';

export interface RoundContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
  /** Slotübergreifend (#204) -- ausschließlich 'limit-until' lebt hier, siehe roundEval. */
  sharedState: StateAdapter;
  /** Ticket-Anspruch bei mehreren Slots (#204), siehe claim.ts. */
  claims: ClaimAdapter;
  /** Dieser Slot -- 1 in der Ein-Slot-Welt (AK9). */
  slotId: string;
  clock: Clock;
}

export interface StatusUpdate {
  title: string;
  emoji: string;
  text: string;
}

export interface RoundPlanOptions {
  queueIssue: number;
  maxRuntime: number;
  /** Hat eine fruehere Runde in DIESEM Tick produktiv gearbeitet? (#61) */
  didWork: boolean;
  lastIssue: string;
  /**
   * Faehrt DIESER Slot gerade die globalen Waechter (#204, Frage 5 = A)?
   * reopenFalselyClosedIssues, die CI-Wache fuer wartende Tickets und
   * claimSweep laufen NUR hier -- sonst kaemen bei mehreren Slots dieselben
   * Issue-Kommentare/Label-Mutationen mehrfach. NICHT betroffen: die CI-Wache
   * fuers eigene laufende Ticket (weiter unten) -- die gehoert in jeden Slot.
   */
  isLead: boolean;
}

/** Die Runde endet ohne Agentenlauf -- Bash schreibt nur noch den Status. */
export interface RoundDone {
  kind: 'done';
  status: StatusUpdate | null;
  rc: number;
}

/** Bash startet `claude` mit genau diesen Werten. */
export interface RoundRun {
  kind: 'run';
  status: StatusUpdate;
  issue: number;
  role: RunRole;
  model: string;
  tools: string;
  /** Session-ID fuer --resume; leer = frischer Start. */
  resume: string;
  labels: string;
  beforeTip: string;
  queueBody: string;
  didWork: boolean;
  lastIssue: string;
  /** Der fertige Prompt -- Bash pipet ihn in `claude` (AK6). */
  prompt: string;
  /**
   * Porcelain-Schnappschuss des Haupt-Checkouts VOR dem Lauf (#325) -- nur
   * fuer plan/research befuellt, '' beim Bauen. roundEval() vergleicht
   * danach nur die DIFFERENZ, nicht gegen leer -- ein schon vorher
   * schmutziger/gestagter Baum (Index zaehlt zum Zustand, Porcelain zeigt
   * ihn in Spalte 1) darf keinen Lese-Lauf mehr faelschlich anklagen.
   */
  beforeDirty: string;
  /** O3 (#325): --disallowedTools fuer den `claude`-Aufruf, '' beim Bauen. */
  denyTools: string;
}

export type RoundPlanResult = RoundDone | RoundRun;

const ERROR_EXCERPT_LIMIT = 1500;

function labelsOf(issue: number, gh: GhAdapter): string {
  try {
    return `${gh.run(['issue', 'view', String(issue), '--json', 'labels', '-q', '.labels[].name']).split('\n').join(' ')} `;
  } catch {
    return '';
  }
}

function hasLabelWord(labels: string, name: string): boolean {
  return ` ${labels} `.includes(` ${name} `);
}

function tryGh(gh: GhAdapter, args: string[]): void {
  try {
    gh.run(args);
  } catch {
    /* wie `2>/dev/null` auf der Bash-Seite: ein fehlgeschlagener Aufruf ist kein Abbruch */
  }
}

// Die Spitze des Feature-Branches VOR dem Lauf -- der Vergleich danach
// entscheidet in buildEscalationEval, ob dieser Lauf Fortschritt gebracht hat
// (ADR-0007).
function branchTip(issue: number, git: GitAdapter): string {
  try {
    const out = git.run(['ls-remote', '--heads', 'origin', `feat/${issue}-*`, `fix/${issue}-*`, `chore/${issue}-*`]);
    const first = out.split('\n').find((line) => line.trim() !== '');
    return first ? (first.split(/\s+/)[0] ?? '') : '';
  } catch {
    return '';
  }
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function hhmm(clock: Clock): string {
  const now = clock.now();
  return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
}

function ddmmHhmm(clock: Clock): string {
  const now = clock.now();
  return `${twoDigits(now.getDate())}.${twoDigits(now.getMonth() + 1)}. ${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
}

function yyyymmdd(clock: Clock): string {
  const now = clock.now();
  return `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
}

// #296: "Queue" ist die Prioritaets-Liste aus #92, kein Synonym fuer jedes
// offene ready/plan/research-Ticket. `queuePending()` zaehlt bewusst auch
// hands-off-Tickets mit (#271 AC3) -- die standen deshalb als "Queue"-Inhalt
// im Status, obwohl #92 leer war. Das Wort faellt nur noch, wenn #92
// tatsaechlich Eintraege hat; die Auswahl selbst bleibt unveraendert.
function pendingWording(pending: string, queueBodyText: string): { title: string; lead: string } {
  if (queueEntries(queueBodyText).length > 0) {
    return { title: `Queue: ${pending}`, lead: `In der Queue liegt noch Arbeit (${pending})` };
  }
  return { title: `Offen: ${pending}`, lead: `Offen ist noch Arbeit (${pending})` };
}

// ---------------------------------------------------------------------------
// Phase 1 -- alles vor dem `claude`-Aufruf
// ---------------------------------------------------------------------------

export function roundPlan(ctx: RoundContext, opts: RoundPlanOptions): RoundPlanResult {
  const { gh, git, state, claims, slotId, clock } = ctx;
  const { isLead } = opts;

  // #204, Frage 5 = A: nur der Leitslot faehrt die globalen Waechter -- sonst
  // schreiben mehrere Slots denselben Issue-Kommentar/dieselbe Label-Mutation
  // mehrfach. Netz gegen faelschlich geschlossene Tickets (#172) -- VOR jeder
  // Ticketauswahl, damit ein hier wieder geoeffnetes Ticket noch im selben
  // Schnappschuss auftaucht statt erst in der naechsten Runde. claimSweep
  // raeumt verwaiste Anspruch VOR der Auswahl weg, damit ein in diesem Tick
  // freigewordenes Ticket noch im selben Schnappschuss waehlbar ist (AK7).
  if (isLead) {
    reopenFalselyClosedIssues(gh);
    claimSweep(claims, gh, clock.now().getTime());
  }

  // EIN Schnappschuss aller offenen Issues statt fuenf sequenzieller
  // gh-Aufrufe. Die Praezedenz der Auswahl bleibt davon unberuehrt.
  let snapshot: QueueIssue[] = [];
  try {
    snapshot = JSON.parse(
      gh.run(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,labels,createdAt']),
    ) as QueueIssue[];
  } catch {
    snapshot = [];
  }

  // #204: welche Issues gehoeren gerade einem ANDEREN Slot? Bewusst NICHT aus
  // `snapshot` entfernt (das braeuchte queueBlocked() unten fuer die
  // Abhaengigkeitspruefung vollstaendig -- sonst saehe ein wartendes Ticket
  // seinen von einem anderen Slot bearbeiteten Blocker faelschlich als
  // erledigt an). Stattdessen reicht diese Menge bis zur Auswahl durch
  // (`wip` unten, `pickTicket()`/`selectTicket()` in select.ts) und schliesst
  // dort zusaetzlich zu BLOCKING_LABELS aus.
  const elsewhere = claimedElsewhere(claims, slotId);

  const body = queueBody(opts.queueIssue, gh);

  // #272: Hier stand die Selbstheilung (#145), die 'in-progress' gegen
  // 'parked' tauschte. Sie ist ersatzlos weg -- 'in-progress' + 'needs-answer'
  // ist jetzt ein gueltiger Zustand, den die Auswahl von selbst ueberspringt.

  // Die Freigabe-Notiz haengt an JEDEM Statustext dieser Runde, unabhaengig
  // davon, welcher der vielen Status-Schreibvorgaenge am Ende greift (#154).
  // Dasselbe gilt fuer den Queue-Bericht (#265): er beschreibt den Zustand der
  // Liste, nicht den Ausgang dieses Takts.
  let releasedNote = '';
  let queueNote = '';
  const status = (title: string, emoji: string, text: string): StatusUpdate => ({
    title,
    emoji,
    text: text + releasedNote + queueNote,
  });

  // --- CI-Wache fuer WARTENDE Tickets (#154, erweitert um #173, seit #272
  // ohne Park-Mechanik) -- #204: NUR der Leitslot, sonst rufen mehrere Slots
  // 'gh pr merge' fuer dasselbe wartende Ticket und posten doppelte Notizen. --
  const waitingOnHuman: WaitingIssueInput[] = isLead
    ? snapshot
        .filter((issue) => issue.labels.some((label) => label.name === 'needs-answer'))
        .map((issue) => ({ number: issue.number, createdAt: issue.createdAt ?? '' }))
    : [];

  if (waitingOnHuman.length > 0) {
    const watched = watchWaitingIssues(waitingOnHuman, { gh, git, state, clock });

    // #217 AC4: ein Ticket landet nur dann in '.released', wenn 'gh pr merge'
    // tatsaechlich geklappt hat -- sonst bleibt es wartend.
    if (watched.released.length > 0) {
      const releasedSet = new Set(watched.released);
      snapshot = snapshot.map((issue) =>
        releasedSet.has(issue.number)
          ? { ...issue, labels: issue.labels.filter((l) => l.name !== 'needs-answer') }
          : issue,
      );
      const list = watched.released.map((n) => `#${n}`).join(', ');
      releasedNote += `\n\n🔓 **Wartendes Ticket freigegeben:** CI komplett grün — Draft auf \`ready\`, Auto-Merge aktiviert: ${list}.`;
    }
  }

  // --- Queue-Bericht + 'blocked-by' nachfuehren (#265) -----------------------
  // Der Runner schreibt Issue 92 NICHT um (Entscheidung vom 27.07.26) -- die
  // Liste bleibt die des Menschen. Was er tut: melden, was daran erledigt ist,
  // was auf Vorarbeit wartet, was gar nicht gelistet ist, und ob sich zwei
  // Eintraege gegenseitig blockieren.
  //
  // 'blocked-by' setzt und entfernt er dagegen selbst (wie 'in-progress'). Von
  // Hand gepflegt wuerde es genauso verrotten wie die Prosa bisher -- nur
  // schlimmer: dann wuerde das Ticket nie wieder gebaut, und zwar still.
  // #204: ebenfalls nur der Leitslot -- sonst schreiben mehrere Slots
  // denselben 'blocked-by'-Zustand jeden Takt neu.
  if (isLead) {
    const entries = queueEntries(body);
    const openIssues = new Set(snapshot.map((issue) => issue.number));
    const blocked = queueBlocked(entries, openIssues);
    const parts: string[] = [];

    for (const issue of snapshot) {
      const hasLabel = issue.labels.some((label) => label.name === 'blocked-by');
      const shouldHave = blocked.has(issue.number);
      if (shouldHave && !hasLabel) {
        tryGh(gh, ['issue', 'edit', String(issue.number), '--add-label', 'blocked-by']);
      } else if (!shouldHave && hasLabel) {
        tryGh(gh, ['issue', 'edit', String(issue.number), '--remove-label', 'blocked-by']);
      }
    }

    const cycles = queueCycles(entries);
    if (cycles.length > 0) {
      parts.push(
        `🔴 **Zirkel in der Queue:** ${cycles.map((n) => `#${n}`).join(', ')} warten aufeinander — keins davon wird gebaut, bis du eine der Abhängigkeiten streichst.`,
      );
    }

    if (blocked.size > 0) {
      const list = [...blocked.entries()]
        .map(([number, blockers]) => `#${number} (nach ${blockers.map((b) => `#${b}`).join(' ')})`)
        .join(', ');
      parts.push(`⛔ Wartet auf Vorarbeit: ${list}.`);
    }

    const done = queueDone(entries, openIssues);
    if (done.length > 0) {
      parts.push(`✅ In der Queue erledigt, kannst du streichen: ${done.map((n) => `#${n}`).join(', ')}.`);
    }

    // Die Queue schlaegt die Label-Kaskade vollstaendig: steht ueberhaupt etwas
    // Baubares in der Liste, kommt kein Ticket ausserhalb dran. Ohne diese
    // Zeile wartet ein frisch auf 'ready' gesetztes Ticket beliebig lange,
    // ohne dass es irgendwo sichtbar wird (#265, Entscheidung: immer melden,
    // keine Schwelle).
    const listed = new Set(entries.map((entry) => entry.issue));
    const starving = snapshot
      .filter(
        (issue) =>
          !listed.has(issue.number) &&
          issue.labels.some((label) => label.name === 'ready') &&
          !issue.labels.some((label) => ['hands-off', 'needs-answer', 'in-progress'].includes(label.name)),
      )
      .map((issue) => issue.number)
      .sort((a, b) => a - b);
    if (listed.size > 0 && starving.length > 0) {
      parts.push(`🟢 Nicht gelistet, wartet auf einen Platz: ${starving.map((n) => `#${n}`).join(', ')}.`);
    }

    if (parts.length > 0) queueNote = `\n\n${parts.join('\n')}`;
  }

  // 1) Laeuft schon eins? -> fortsetzen (WIP-Limit = 1). 'needs-answer'
  //    schliesst aus: dieses Ticket wartet auf den Menschen. Es behaelt dabei
  //    'in-progress' (#272) -- der Bauplatz gilt trotzdem als frei, weil dieser
  //    Filter greift, und derselbe Zweig nimmt die Arbeit wieder auf, sobald
  //    das Label faellt.
  // #204: ein 'in-progress'-Ticket, dessen Claim einem ANDEREN Slot gehoert
  // (z. B. von Hand gelabelt, bevor es hier je beansprucht wurde), ist fuer
  // diesen Slot kein eigenes WIP -- sonst wuerden zwei Slots dasselbe Ticket
  // "fortsetzen".
  const wip = snapshot.filter(
    (issue) => issue.labels.some((label) => label.name === 'in-progress') && !elsewhere.has(issue.number),
  );
  const resumable = wip
    .filter((issue) => !issue.labels.some((label) => label.name === 'needs-answer'))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

  let issue = resumable.length > 0 ? resumable[0]!.number : 0;
  let mode = 'resume';
  let role: RunRole = 'build';
  let ciFix = false;
  let ciSummary = '';

  // --- CI-Wache fuer ein laufendes Bau-Ticket (#147) ------------------------
  // Hat DIESES Ticket schon einen offenen PR, entscheidet allein dessen
  // CI-Zustand den Takt: kein Agentenlauf fuers Warten, kein Wechsel auf ein
  // anderes Ticket, solange hier noch etwas offen ist.
  if (issue > 0) {
    const prNum = prForIssue(issue, gh);
    if (prNum !== '') {
      const watch = watchRunningIssue(issue, prNum, { gh, git, state, clock });
      switch (watch.kind) {
        case 'pending':
          // #324: haengt der Check laenger als PENDING_STALL_MINUTES, ist
          // "kein Eingreifen nötig" nicht mehr wahr -- ein Drittel der Flotte
          // stand deshalb schon einmal zwei Stunden lang gruen und still.
          if (watch.escalated) {
            return {
              kind: 'done',
              rc: 0,
              status: status(
                `wartet auf dich (#${issue}): CI hängt seit ${watch.minutes} Minuten`,
                '🟡',
                `🟡 **CI hängt seit ${watch.minutes} Minuten für #${issue}** (PR #${prNum}), ohne durchzulaufen.

Bitte auf GitHub nachsehen, ob der Check wirklich noch arbeitet oder festhängt.`,
              ),
            };
          }
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `CI läuft für #${issue}`,
              '🟢',
              `🟢 **CI läuft für #${issue}** (PR #${prNum}) — kein laufender Prozess hier.

Der nächste Takt prüft erneut, sobald die Checks durch sind. **Kein Eingreifen nötig.**`,
            ),
          };
        case 'merged':
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `wartet auf Merge · #${issue}`,
              '🟢',
              `🟢 **CI grün für #${issue}** (PR #${prNum}) — als \`ready\` markiert, Auto-Merge aktiviert.

GitHub mergt, sobald alle Required Checks final durch sind. **Kein Eingreifen nötig.**`,
            ),
          };
        case 'caught-up':
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `CI läuft für #${issue}`,
              '🟢',
              `🟢 **Branch für #${issue} nachgezogen** (PR #${prNum} lag hinter \`main\`) — per \`git\` gemergt und gepusht, kein Agentenlauf. CI läuft jetzt neu.

Der nächste Takt prüft erneut. **Kein Eingreifen nötig.**`,
            ),
          };
        case 'retry': {
          // #171: Ursache immer benennen, stoerende Pfade mitliefern, ab der
          // dritten Runde in Folge mit DERSELBEN Ursache auf 🟡 wechseln.
          const paths = watch.paths.length > 0 ? `\n\nStörende Pfade: \`${watch.paths.join(',')}\`` : '';
          if (watch.escalated) {
            return {
              kind: 'done',
              rc: 0,
              status: status(
                `wartet auf dich (#${issue})`,
                '🟡',
                `🟡 **Nachziehen von \`main\` für #${issue} (PR #${prNum}) hängt fest.**

Ursache seit drei Runden in Folge dieselbe: ${watch.reason}.${paths}

Das löst sich nicht von selbst — der Runner räumt keine fremden Dateien weg. Bitte
im Arbeitsbaum des Runners nachsehen und aufräumen, dann läuft der nächste Takt normal weiter.`,
              ),
            };
          }
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `CI läuft für #${issue}`,
              '🟢',
              `🟢 **CI läuft für #${issue}** (PR #${prNum}) — Branch liegt hinter \`main\`, das Nachziehen ist gerade nicht möglich (${watch.reason}).${paths} Nächster Takt versucht es erneut. **Kein Eingreifen nötig.**`,
            ),
          };
        }
        case 'build-fix':
          // Deckt beide Konflikt-Wege ab: den beim Nachziehen entstandenen
          // UND den von GitHub gemeldeten DIRTY-PR (#217).
          ciFix = true;
          ciSummary = watch.summary;
          break;
      }
    }
  }

  if (issue === 0) {
    const pick = pickTicket(snapshot, body, gh, state, elsewhere);
    switch (pick.kind) {
      case 'ticket':
        issue = pick.issue;
        role = pick.role;
        mode = pick.mode;
        break;
      case 'none': {
        // Nichts zu holen. Aber liegt etwas bei DIR? Dann ist Gelb die
        // Wahrheit -- "nichts zu tun" waere eine Luege, die dich das Ticket
        // uebersehen laesst.
        const waiting = snapshot
          .filter((i) => i.labels.some((label) => label.name === 'needs-answer'))
          .sort((a, b) => a.number - b.number)
          .map((i) => `#${i.number}`)
          .join(', ');
        if (waiting !== '') {
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `wartet auf dich (${waiting})`,
              '🟡',
              `🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: ${waiting}

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-answer\`** —
sonst starte ich in 60 Sekunden mit derselben offenen Frage neu.`,
            ),
          };
        }
        const pending = queuePending(queueSnapshot(gh));
        if (pending !== '') {
          const { title, lead } = pendingWording(pending, body);
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `wartet auf nächsten Lauf · ${title}`,
              '🟢',
              `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

${lead}, aber derzeit kein baubereites Ticket (z. B. nur Recherche). **Kein Eingreifen nötig.**`,
            ),
          };
        }
        if (opts.didWork) {
          // Chaining (#61): eine fruehere Runde hat produktiv gearbeitet,
          // jetzt ist die Queue leer -- ⚪️ "nichts zu tun" klaenge nach "nie
          // etwas getan" und waere hier falsch.
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `läuft · zuletzt #${opts.lastIssue}`,
              '🟢',
              `🟢 **Nichts offen.** Zuletzt an #${opts.lastIssue} gearbeitet, die Queue ist leer.
Kein Eingreifen nötig.`,
            ),
          };
        }
        return {
          kind: 'done',
          rc: 0,
          status: status(
            'nichts zu tun',
            '⚪️',
            `⚪️ Kein Ticket mit Label \`ready\`, \`plan\` oder \`research\`. Ich habe nichts zu arbeiten.

Gib ein Ticket frei, indem du ihm das Label \`ready\` gibst.`,
          ),
        };
      }
    }
  }

  // #204: der eine Punkt, an dem sich DIESER Slot fuer 'issue' festlegt. Der
  // Filter oben hat fremd beanspruchte Tickets schon aus dem Schnappschuss
  // geworfen -- trotzdem kann ein anderer Slot im selben Wimpernschlag
  // zugegriffen haben (mkdir ist atomar, das Fenster dazwischen nicht null).
  // Scheitert der Claim, endet die Runde ergebnislos: kein Agentenlauf, der
  // naechste Takt waehlt neu. Deckt beide Wege ab, die hierher fuehren --
  // fortgesetztes 'in-progress' oben UND ein frisch von pickTicket()
  // gewaehltes Ticket.
  if (!claimTake(claims, issue, slotId)) {
    return {
      kind: 'done',
      rc: 0,
      status: status(
        `#${issue} an anderen Slot verloren`,
        '🟢',
        `🟢 **#${issue}** wurde im selben Moment von einem anderen Slot beansprucht — kein Agentenlauf hier. Der nächste Takt wählt neu. **Kein Eingreifen nötig.**`,
      ),
    };
  }

  // Ab hier ist das Ticket fest und der `claude`-Aufruf steht kurz bevor.
  // Genau das war die Luecke aus #19: zwischen Ticketwahl und Rueckkehr des
  // Laufs stand im Status noch der Stand des LETZTEN Laufs.
  const startHm = hhmm(clock);
  const minutes = Math.floor(opts.maxRuntime / 60);

  // Ein wartendes Ticket kann neben dem aktiven koexistieren (#145, seit #272
  // ohne Parken) -- die Busy-Meldung darf das nicht verschweigen, sonst
  // uebersieht man auf dem Handy, dass woanders eine Antwort faellig ist.
  const waitingNow = waitingIssues(gh);
  const parkedNote =
    waitingNow === ''
      ? ''
      : `\n\n🟡 Wartet zusätzlich auf dich: ${waitingNow} (Antwort + \`needs-answer\` entfernen setzt die Arbeit dort fort).`;

  // --- Modell nach Eskalationsstufe/Label/Rolle (ADR-0013) -------------------
  // Praezedenz, von stark nach schwach:
  //
  //   tier-<nr> gesetzt (eskaliert)  -> diese Stufe   (ADR-0007)
  //   model:*-Label am Ticket        -> dessen Stufe  (ADR-0013, auch fuer
  //                                                    die Denk-Rollen)
  //   Rolle plan/research            -> opus          (ADR-0005, unveraendert)
  //   sonst                          -> sonnet
  //
  // Das Label ist die STARTSTUFE, nicht die Fessel: eine schon eingetretene
  // Eskalation schlaegt es, sonst haenge ein 'model:sonnet'-Ticket fuer immer
  // auf Sonnet fest. Fuer die Bau-Rolle steckt genau diese Reihenfolge bereits
  // in tierCurrent(); hier oben bleibt nur, was die Denk-Rollen und
  // 'no-escalation' davon abweichend brauchen.
  //
  // Steht die Stufe vor dem Status-Block, damit die Ampel sie nennen kann --
  // vom Handy aus ist sonst nicht sichtbar, dass der naechste Lauf Opus
  // verbrennt (#273).
  const labels = labelsOf(issue, gh);
  const labelTier = tierFromLabels(issue, gh);
  let model: string;
  if (labels.includes('no-escalation')) {
    // Einfrieren heisst: keine Eskalation, nicht "keine Wahl" -- die am Ticket
    // gesetzte Startstufe gilt trotzdem.
    model = labelTier ?? 'sonnet';
  } else if (role === 'plan' || role === 'research') {
    model = labelTier ?? 'opus';
  } else {
    model = tierCurrent(issue, state, gh);
  }

  const busy =
    role === 'plan'
      ? status(
          `plant #${issue} (${model}, seit ${startHm})`,
          '🟠',
          `🟠 **Plant gerade #${issue}** (${model}, nur lesend), seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
        )
      : role === 'research'
        ? status(
            `recherchiert #${issue} (${model}, seit ${startHm})`,
            '🟠',
            `🟠 **Recherchiert gerade #${issue}** (${model}, nur lesend), seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
          )
        : status(
            `arbeitet an #${issue} (${model}, seit ${startHm})`,
            '🟠',
            `🟠 **Arbeitet gerade an #${issue}** (Stufe: ${model}), seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
          );

  // --- Opus-Bau-Deckel (ADR-0007) -------------------------------------------
  // Greift VOR dem Aufruf, damit ein erschoepftes Tagesbudget nicht noch einen
  // teuren dritten Opus-Lauf kostet.
  if (role === 'build' && model === 'opus') {
    if (opusBuildCapReached(issue, labels, state, clock)) {
      // Meldung hoechstens einmal je Ticket und Tag (#136).
      const stamp = `opus-cap-msg-${yyyymmdd(clock)}-${issue}`;
      if (!state.exists(stamp)) {
        tryGh(gh, [
          'issue',
          'comment',
          String(issue),
          '--body',
          `🤖 Opus-Tagesbudget (2 Bau-Läufe) für #${issue} ist für heute erschöpft — die Eskalation bleibt auf der höchsten Stufe stecken.

Morgen geht ein neuer Opus-Bau-Versuch automatisch weiter. Setze das Label \`opus-boost\`, um für dieses Ticket noch heute einen weiteren Opus-Bau-Versuch freizugeben (wird nur bei ausbleibendem Fortschritt wieder abgezogen). Willst du dauerhaft bei Sonnet/Haiku bleiben, setze stattdessen das Label \`no-escalation\`.`,
        ]);
        state.write(stamp, '');
      }
      // #272: NICHT 'needs-answer'. Der Tagesdeckel wartet auf Zeit, nicht auf
      // eine geschriebene Antwort -- morgen laeuft er von selbst weiter. Genau
      // dafuer gibt es 'blocked-limit' ("Wird automatisch fortgesetzt"). Bis S2b
      // stand hier 'needs-input' ohne den 'needs-answer'-Marker; mit nur noch
      // einem Wartelabel waere das jetzt eine Luege im Status-Issue.
      tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'blocked-limit']);
      return {
        kind: 'done',
        rc: 0,
        status: status(
          // #283: hiess bis heute "wartet auf dich (#N)". Der Deckel setzt
          // 'blocked-limit' und laeuft morgen von selbst weiter -- niemand
          // schuldet eine Antwort. 🟡 bleibt trotzdem richtig: die Eskalation
          // klemmt auf der hoechsten Stufe, und dagegen hilft nur ein Mensch
          // ('opus-boost' oder 'no-escalation').
          `Opus-Deckel (#${issue})`,
          '🟡',
          `🟡 **Opus-Tagesbudget für #${issue} erschöpft.** Morgen läuft es von selbst weiter; \`opus-boost\` gibt heute noch einen Versuch frei.`,
        ),
      };
    }
    opusBuildCapReserve(issue, state, clock);
  }

  const beforeTip = role === 'build' ? branchTip(issue, git) : '';

  // Resume-Deckel nur fuers Bauen (#62): die Denk-Rollen tragen ihren Kontext
  // bewusst in der Session, dort ist die breite Lektuere der Auftrag. Fuers
  // Bauen liegt der Stand in Git + Fortschrittskommentar.
  const sid = state.read(`session-${issue}`) ?? '';
  let resume = '';
  if (mode === 'resume' && sid !== '' && (role !== 'build' || resumeAllowed(issue, state).allowed)) {
    resume = sid;
  }

  const prompt =
    role === 'plan'
      ? planPrompt(issue)
      : role === 'research'
        ? researchPrompt(issue)
        : ciFix
          ? ciFixPrompt(issue, ciSummary)
          : buildPrompt(issue);

  const tools =
    role === 'plan' ? READONLY_TOOLS : role === 'research' ? `${READONLY_TOOLS},WebSearch` : BUILD_TOOLS;

  // O2/O3 (#325): nur die Denk-Rollen laufen in einem Wegwerf-Worktree UND
  // bekommen die harte Werkzeug-Verweigerung -- die Bau-Rolle hat ihren
  // eigenen Worktree bereits (#242) und braucht Edit/Write.
  const denyTools = role === 'plan' || role === 'research' ? READONLY_DENY : '';

  // Baseline VOR dem Lauf, ausschliesslich fuer das Read-only-Netz unten in
  // roundEval() -- der Wegwerf-Worktree macht das eigentlich ueberfluessig,
  // bleibt aber als zweite Absicherung (Guertel und Hosentraeger, #325).
  let beforeDirty = '';
  if (role === 'plan' || role === 'research') {
    try {
      beforeDirty = git.run(['status', '--porcelain']);
    } catch {
      beforeDirty = '';
    }
  }

  return {
    kind: 'run',
    status: busy,
    issue,
    role,
    model,
    tools,
    resume,
    labels,
    beforeTip,
    queueBody: body,
    didWork: opts.didWork,
    lastIssue: opts.lastIssue,
    prompt,
    beforeDirty,
    denyTools,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 -- alles nach dem `claude`-Aufruf
// ---------------------------------------------------------------------------

export interface RoundOutcome {
  /** Exit-Code von `claude`. */
  rc: number;
  /** stdout des Laufs (JSON von `claude -p --output-format json`). */
  out: string;
  /** Hat die Notbremse zugeschlagen? (run_limited, Bash) */
  timedOut: boolean;
  maxRuntime: number;
}

export interface RoundEvalResult {
  status: StatusUpdate | null;
  /** Setzt main() die Chain-Schleife fort? Nur ein sauberer Lauf tut das (#61). */
  chain: 'continue' | 'stop';
  rc: number;
  didWork: boolean;
  lastIssue: string;
}

function parseField(out: string, field: string): string {
  try {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  } catch {
    return '';
  }
}

function errorExcerpt(out: string, log: string): string {
  let txt = parseField(out, 'result');
  if (txt === '') txt = log.split('\n').slice(-20).join('\n');
  if (txt.length > ERROR_EXCERPT_LIMIT) return `${txt.slice(0, ERROR_EXCERPT_LIMIT)}\n…(gekürzt)`;
  return txt;
}

// Traegt den skriptseitig bekannten Endgrund (Limit/Notbremse) in den
// BESTEHENDEN Fortschrittskommentar nach -- der Agent kennt beim Abbruch selbst
// nur 'gate-rot'/'frage-offen', nicht Limit/Timeout: sein Prozess ist in dem
// Moment schon tot.
function appendEndReason(issue: number, reason: string, gh: GhAdapter, clock: Clock): void {
  let last = '';
  try {
    last = gh.run(['issue', 'view', String(issue), '--json', 'comments', '-q', '.comments[-1].body // empty']);
  } catch {
    return;
  }
  if (!last.includes('Fortschritt (automatisch aktualisiert)')) return;
  tryGh(gh, [
    'issue',
    'comment',
    String(issue),
    '--edit-last',
    '--body',
    `${last}\n\n_Lauf-Ende ${ddmmHhmm(clock)}: ${reason}, unfertig — nächster Lauf macht weiter._`,
  ]);
}

export function roundEval(ctx: RoundContext, plan: RoundRun, outcome: RoundOutcome, log: string): RoundEvalResult {
  const { gh, git, state, sharedState, clock } = ctx;
  const { issue, role } = plan;
  const stop = (status: StatusUpdate | null, rc: number): RoundEvalResult => ({
    status,
    chain: 'stop',
    rc,
    didWork: plan.didWork,
    lastIssue: plan.lastIssue,
  });

  // Session-ID sichern. Nach einem Timeout-Kill ist $OUT kein valides JSON --
  // eine leere Zeile wuerde die noch gueltige alte ID ueberschreiben, und der
  // naechste Lauf koennte nicht mehr fortsetzen (#64).
  const sid = parseField(outcome.out, 'session_id');
  if (sid !== '') state.write(`session-${issue}`, sid);

  // Ein frueherer Lauf koennte 'blocked-limit' gesetzt haben. Kommen wir hier
  // an, ist das Limit vorbei -- das Label ist in JEDEM Ausgang unten stale.
  tryGh(gh, ['issue', 'edit', String(issue), '--remove-label', 'blocked-limit']);

  // --- Read-only-Netz fuer Planer & Rechercheur (ADR-0005 + #63, ueberholt
  // durch #325) -----------------------------------------------------------
  // Seit #325 laufen Denk-Rollen in einem Wegwerf-Worktree (O2) -- dieses
  // Netz ist die zweite Absicherung (Guertel und Hosentraeger), kein
  // Primaerschutz mehr. Es ist ausserdem ein reiner TRIPWIRE: es raeumt
  // NIE mehr auf (kein `checkout -- .` + `clean -fd`). Der Grund ist
  // Index-Zustand: `git status --porcelain` zeigt gestagte Aenderungen in
  // Spalte 1, und `checkout`/`clean` fassen den Index nie an -- ein schon
  // vorher gestagt-schmutziger Baum konnte das alte Netz also NIE aufloesen
  // und hat jeden Lese-Lauf dort faelschlich angeklagt (#301/#322,
  // Live-Beleg in #325). Deshalb vergleicht dieser Code die vor dem Lauf
  // (roundPlan) genommene Baseline `plan.beforeDirty` gegen den Stand
  // JETZT und beanstandet nur die DIFFERENZ. Fremd-Dirt (vor dem Lauf schon
  // da, danach unveraendert) bleibt unangetastet liegen und wird nicht
  // gemeldet -- nur echte NEUE Zeilen loesen die Anklage aus.
  if (role === 'plan' || role === 'research') {
    let after = '';
    try {
      after = git.run(['status', '--porcelain']);
    } catch {
      after = '';
    }
    const before = new Set(plan.beforeDirty.split('\n').filter((l) => l !== ''));
    const newLines = after.split('\n').filter((l) => l !== '' && !before.has(l));

    if (newLines.length > 0) {
      const roleLabel = role === 'research' ? 'Recherche-Lauf' : 'Planer-Lauf';
      const paths = newLines.join('\n');
      tryGh(gh, [
        'issue',
        'comment',
        String(issue),
        '--body',
        `🤖 Der ${roleLabel} (Opus, nur lesend) hat entgegen der Regel den Haupt-Checkout verändert. Nicht aufgeräumt (der Index zählt zum Zustand — \`checkout\`/\`clean\` könnten fremde gestagte Arbeit zerstören). Betroffene Zeilen:
\`\`\`
${paths}
\`\`\`
Siehe ADR-0005 (Read-only-Netz).`,
      ]);
      tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'needs-answer']);
      return stop(
        {
          title: `Fehler bei #${issue}`,
          emoji: '🔴',
          text: `🔴 **Fehler bei #${issue}.** Der ${roleLabel} hat unerwartet den Haupt-Checkout geändert — nicht aufgeräumt, siehe Kommentar.

Details stehen als Kommentar am Ticket. Ich fasse #${issue} nicht wieder an, solange \`needs-answer\` hängt.`,
        },
        1,
      );
    }
    // beforeDirty !== '', aber keine neuen Zeilen -> Fremd-Dirt lag schon
    // vorher da und ist unveraendert: keine Anklage, kein Aufraeumen, Chain
    // laeuft normal weiter.
  }

  const transientFile = `transient-${issue}`;

  // --- Auswertung: sauberer Lauf -------------------------------------------
  if (outcome.rc === 0) {
    state.remove(transientFile);

    // Ein sauberer Lauf kann trotzdem "sauber-aber-festhaengend" sein (kein
    // Commit) -- das entscheidet die Eskalation (ADR-0007).
    buildEscalationEval(
      { issue, runRole: role, labels: plan.labels, beforeTip: plan.beforeTip, model: plan.model },
      state,
      gh,
      git,
    );

    // Hat Claude bei GENAU DIESEM Ticket eine Frage gestellt? Bewusst nicht
    // global gefragt (#145): ein woanders wartendes Ticket darf die
    // Chain-Fortsetzung eines unabhaengigen, sauberen Laufs nicht verhindern.
    const postLabels = labelsOf(issue, gh);
    if (hasLabelWord(postLabels, 'needs-answer')) {
      // #272: kein Umlabeln mehr. Das Ticket behaelt 'in-progress'; die
      // Auswahl ueberspringt es wegen 'needs-answer' und nimmt es ueber
      // denselben Zweig wieder auf, sobald der Mensch geantwortet hat.
      const waiting = waitingIssues(gh);
      return stop(
        {
          title: `wartet auf dich (${waiting})`,
          emoji: '🟡',
          text: `🟡 **Ich warte auf eine Antwort von dir.**

Offene Fragen an: ${waiting}

Antworte als Kommentar am Ticket und **entferne dann das Label \`needs-answer\`**.`,
        },
        0,
      );
    }

    // Die einzige Stelle, die die Chain-Schleife fortsetzt (#61).
    const snap = queueSnapshot(gh);
    const pending = queuePending(snap);
    const next = queueNext(snap, plan.queueBody);
    const done = (status: StatusUpdate): RoundEvalResult => ({
      status,
      chain: 'continue',
      rc: 0,
      didWork: true,
      lastIssue: String(issue),
    });

    if (pending !== '') {
      const { title, lead } = pendingWording(pending, plan.queueBody);
      if (next !== null) {
        return done({
          title: `wartet auf nächsten Lauf · als Nächstes #${next}`,
          emoji: '🟢',
          text: `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #${issue} gearbeitet. Als Nächstes ist **#${next}** dran. Der nächste Takt
startet automatisch (~5 Min) — **kein Eingreifen nötig.**

${title}`,
        });
      }
      return done({
        title: `wartet auf nächsten Lauf · ${title}`,
        emoji: '🟢',
        text: `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #${issue} gearbeitet. ${lead}, aber
derzeit kein baubereites Ticket (z. B. nur Recherche). **Kein Eingreifen nötig.**`,
      });
    }
    return done({
      title: `nichts offen · zuletzt #${issue}`,
      emoji: '🟢',
      text: `🟢 **Nichts offen.** Zuletzt an #${issue} gearbeitet, die Queue ist leer.
Kein Eingreifen nötig.`,
    });
  }

  // Exit-Codes von 'claude -p' sind nicht stabil dokumentiert -> auf
  // null/nicht-null pruefen und die Ausgabe lesen. Zuerst der Statuscode: 429
  // ist stabil, der Begleitsatz nicht. Genau daran ist die alte Erkennung
  // gescheitert -- sie kannte "usage limit", aber nicht "session limit".
  const apiStatus = parseField(outcome.out, 'api_error_status');
  const resultTxt = parseField(outcome.out, 'result');

  if (apiStatus === '429' || /usage limit|rate limit|session limit|limit reached|quota/i.test(outcome.out)) {
    const epoch = resetEpoch(resultTxt, clock);
    let when: string;
    if (epoch !== null) {
      // Slotübergreifend (#204): das Kontingent ist EINS, nicht pro Slot --
      // schriebe das hier in 'state' (slot-lokal), rennte jeder andere Slot
      // weiter in 429er, waehrend dieser korrekt pausiert.
      sharedState.write('limit-until', String(epoch));
      when = ` Nächster Versuch: ${fmtHm(epoch)} Uhr.`;
    } else {
      // Nicht deutbar -> 5-Minuten-Takt wie bisher (Retries kosten im Limit
      // nichts, sie kommen sofort als 429 zurueck). Den Wortlaut mitschreiben:
      // so gibt es beim naechsten unbekannten Limit-Text eine Vorlage.
      const prev = state.read('unparsed-limits.log') ?? '';
      state.write('unparsed-limits.log', `${prev}${ddmmHhmm(clock)}\t${resultTxt}\n`);
      when = ' Nächster Versuch: in ~5 Minuten.';
    }
    tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'blocked-limit']);
    appendEndReason(issue, 'Session-Limit', gh, clock);
    return stop(
      {
        title: `Limit erreicht · #${issue} pausiert`,
        emoji: '🔵',
        text: `🔵 **Limit erreicht.** Ticket #${issue} ist angehalten und wird automatisch
fortgesetzt, sobald wieder Kontingent da ist.${when}

**Kein Eingreifen nötig.** Der Arbeitsstand liegt in Git und im Fortschrittskommentar,
nicht in der Session.`,
      },
      0, // kein Fehler -- der Timer probiert es einfach wieder
    );
  }

  if (outcome.timedOut) {
    appendEndReason(issue, `Notbremse ${outcome.maxRuntime}s`, gh, clock);
    return stop(
      {
        title: `Notbremse bei #${issue}`,
        emoji: '🔵',
        text: `🔵 Lauf an #${issue} nach ${outcome.maxRuntime}s abgebrochen (Notbremse gegen hängende Läufe).
Wird beim nächsten Lauf fortgesetzt. **Kein Eingreifen nötig.**`,
      },
      0,
    );
  }

  // --- Voruebergehender API-Fehler? ----------------------------------------
  // Weder Limit noch inhaltlicher Fehlschlag -- ein Haenger mitten in der
  // Antwort. Der richtige Umgang ist ein neuer Versuch beim naechsten Takt,
  // kein needs-answer. Zaehlt bewusst NICHT als Eskalations-Fehlversuch
  // (ADR-0007): Infrastruktur, kein Inhalt.
  const transient =
    ['500', '502', '503', '504', '529'].includes(apiStatus) ||
    /api error|server error|overloaded|connection error|timed? ?out/i.test(`${outcome.out}\n${resultTxt}`);

  if (transient) {
    const count = Number(state.read(transientFile) ?? '0') + 1;
    if (count < 3) {
      state.write(transientFile, String(count));
      return stop(
        {
          title: `vorübergehender API-Fehler bei #${issue}`,
          emoji: '🔵',
          text: `🔵 **Vorübergehender API-Fehler bei #${issue}** (Versuch ${count} von 3). Neuer
Versuch beim nächsten Takt. **Kein Eingreifen nötig.** Der Arbeitsstand liegt in
Git und im Fortschrittskommentar, nicht in der Session.`,
        },
        0,
      );
    }

    // Drittes Mal in Folge -- das ist kein Zufall mehr.
    state.remove(transientFile);
    tryGh(gh, [
      'issue',
      'comment',
      String(issue),
      '--body',
      `🤖 Der Runner ist dreimal in Folge an einem
vorübergehenden API-Fehler gescheitert (zuletzt Exit ${outcome.rc}).
Letzte Zeilen:
\`\`\`
${errorExcerpt(outcome.out, log)}
\`\`\``,
    ]);
    tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'needs-answer']);
    return stop(
      {
        title: `Fehler bei #${issue}`,
        emoji: '🔴',
        text: `🔴 **Fehler bei #${issue}.** Dreimal in Folge ein vorübergehender API-Fehler —
das ist kein Zufall mehr.

Die Details stehen als Kommentar am Ticket. Ich fasse #${issue} nicht wieder an,
solange das Label \`needs-answer\` hängt.`,
      },
      1,
    );
  }

  // Ein "echter" inhaltlicher Fehlschlag -- das zaehlt als
  // Eskalations-Fehlversuch (ADR-0007).
  buildEscalationEval(
    { issue, runRole: role, labels: plan.labels, beforeTip: plan.beforeTip, model: plan.model },
    state,
    gh,
    git,
  );
  tryGh(gh, [
    'issue',
    'comment',
    String(issue),
    '--body',
    `🤖 Der Runner ist mit einem Fehler abgebrochen (Exit ${outcome.rc}).
Letzte Zeilen:
\`\`\`
${errorExcerpt(outcome.out, log)}
\`\`\``,
  ]);
  tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'needs-answer']);
  return stop(
    {
      title: `Fehler bei #${issue}`,
      emoji: '🔴',
      text: `🔴 **Fehler bei #${issue}.** Der Runner ist abgebrochen (Exit ${outcome.rc}).

Die Details stehen als Kommentar am Ticket. Ich fasse #${issue} nicht wieder an,
solange das Label \`needs-answer\` hängt.`,
    },
    1,
  );
}
