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
import type { QueueIssue } from './queue.js';
import { queuePending } from './queue.js';
import { queueBody, queueSnapshot, waitingIssues } from './status.js';
import { pickTicket, queueNext, type RunRole } from './select.js';
import { watchWaitingIssues, watchRunningIssue, type WaitingIssueInput } from './watch.js';
import { prForIssue, reopenFalselyClosedIssues } from './pr.js';
import { tierCurrent } from './tier.js';
import { buildEscalationEval, resumeAllowed } from './escalation.js';
import { opusBuildCapReached, opusBuildCapReserve } from './cap.js';
import { fmtHm, resetEpoch } from './time.js';
import { BUILD_TOOLS, READONLY_TOOLS, buildPrompt, ciFixPrompt, planPrompt, researchPrompt } from './prompts.js';

export interface RoundContext {
  gh: GhAdapter;
  git: GitAdapter;
  state: StateAdapter;
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

// ---------------------------------------------------------------------------
// Phase 1 -- alles vor dem `claude`-Aufruf
// ---------------------------------------------------------------------------

export function roundPlan(ctx: RoundContext, opts: RoundPlanOptions): RoundPlanResult {
  const { gh, git, state, clock } = ctx;

  // Netz gegen faelschlich geschlossene Tickets (#172) -- VOR jeder
  // Ticketauswahl, damit ein hier wieder geoeffnetes Ticket noch im selben
  // Schnappschuss auftaucht statt erst in der naechsten Runde.
  reopenFalselyClosedIssues(gh);

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

  const body = queueBody(opts.queueIssue, gh);

  // #272: Hier stand die Selbstheilung (#145), die 'in-progress' gegen
  // 'parked' tauschte. Sie ist ersatzlos weg -- 'in-progress' + 'needs-answer'
  // ist jetzt ein gueltiger Zustand, den die Auswahl von selbst ueberspringt.

  // Die Freigabe-Notiz haengt an JEDEM Statustext dieser Runde, unabhaengig
  // davon, welcher der vielen Status-Schreibvorgaenge am Ende greift (#154).
  let releasedNote = '';
  const status = (title: string, emoji: string, text: string): StatusUpdate => ({
    title,
    emoji,
    text: text + releasedNote,
  });

  // --- CI-Wache fuer WARTENDE Tickets (#154, erweitert um #173, seit #272
  // ohne Park-Mechanik) ------------------------------------------------------
  const waitingOnHuman: WaitingIssueInput[] = snapshot
    .filter((issue) => issue.labels.some((label) => label.name === 'needs-answer'))
    .map((issue) => ({ number: issue.number, createdAt: issue.createdAt ?? '' }));

  if (waitingOnHuman.length > 0) {
    const watched = watchWaitingIssues(waitingOnHuman, { gh, git, state });

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

  // 1) Laeuft schon eins? -> fortsetzen (WIP-Limit = 1). 'needs-answer'
  //    schliesst aus: dieses Ticket wartet auf den Menschen. Es behaelt dabei
  //    'in-progress' (#272) -- der Bauplatz gilt trotzdem als frei, weil dieser
  //    Filter greift, und derselbe Zweig nimmt die Arbeit wieder auf, sobald
  //    das Label faellt.
  const wip = snapshot.filter((issue) => issue.labels.some((label) => label.name === 'in-progress'));
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
      const watch = watchRunningIssue(issue, prNum, { gh, git, state });
      switch (watch.kind) {
        case 'pending':
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
        case 'protected-red':
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `wartet auf dich (#${issue})`,
              '🟡',
              `🟡 **PR #${prNum} für #${issue} braucht deine Freigabe.**

Der Check \`protected-paths\` ist rot. Seit #276 blockiert er eigentlich nicht mehr —
tritt das trotzdem auf, sieh ins Check-Log: es ist dann eine echte Störung, keine
fehlende Freigabe.`,
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
    const pick = pickTicket(snapshot, body, gh, state);
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
sonst starte ich in 5 Minuten mit derselben offenen Frage neu.`,
            ),
          };
        }
        const pending = queuePending(queueSnapshot(gh));
        if (pending !== '') {
          return {
            kind: 'done',
            rc: 0,
            status: status(
              `wartet auf nächsten Lauf · Queue: ${pending}`,
              '🟢',
              `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

In der Queue liegt noch Arbeit (${pending}), aber derzeit kein baubereites Ticket
(z. B. nur Recherche). **Kein Eingreifen nötig.**`,
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

  const busy =
    role === 'plan'
      ? status(
          `plant #${issue} (seit ${startHm})`,
          '🟠',
          `🟠 **Plant gerade #${issue}** (Opus, nur lesend), seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
        )
      : role === 'research'
        ? status(
            `recherchiert #${issue} (seit ${startHm})`,
            '🟠',
            `🟠 **Recherchiert gerade #${issue}** (Opus, nur lesend), seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
          )
        : status(
            `arbeitet an #${issue} (seit ${startHm})`,
            '🟠',
            `🟠 **Arbeitet gerade an #${issue}**, seit ${startHm}.

Laeuft bis zu ${minutes} Minuten. **Kein Eingreifen noetig**, solange
hier keine anderen Status (🟡/🔴) folgen.${parkedNote}`,
          );

  // --- Modell nach Rolle/Label/Eskalationsstufe -----------------------------
  // Denk-Rollen laufen immer mit Opus (ADR-0005). Bau-Rolle: tierCurrent
  // liefert die Eskalationsstufe (ADR-0007); 'no-escalation' friert auf der
  // Default-Stufe ein, unabhaengig von einer schon gesetzten Stufe.
  const labels = labelsOf(issue, gh);
  let model: string;
  if (role === 'plan' || role === 'research') {
    model = 'opus';
  } else if (labels.includes('no-escalation')) {
    model = labels.includes('model:haiku') ? 'haiku' : 'sonnet';
  } else {
    model = tierCurrent(issue, state, gh);
  }

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
          `wartet auf dich (#${issue})`,
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
  const { gh, git, state, clock } = ctx;
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

  // --- Read-only-Netz fuer Planer & Rechercheur (ADR-0005 + #63) -----------
  // Zweite Absicherung neben der Werkzeug-Allowlist: selbst mit enger Liste
  // koennte ein Fehlverhalten den Baum beschmutzen. Das darf nie unbemerkt
  // durchrutschen -- verwerfen und als Fehler behandeln, unabhaengig vom
  // Exit-Code (auch ein "erfolgreicher" Lauf zaehlt hier nicht).
  if (role === 'plan' || role === 'research') {
    let dirty = '';
    try {
      dirty = git.run(['status', '--porcelain']);
    } catch {
      dirty = '';
    }
    if (dirty !== '') {
      try {
        git.run(['checkout', '--', '.']);
      } catch {
        /* best effort, wie `2>/dev/null` */
      }
      try {
        git.run(['clean', '-fd']);
      } catch {
        /* best effort */
      }
      const roleLabel = role === 'research' ? 'Recherche-Lauf' : 'Planer-Lauf';
      tryGh(gh, [
        'issue',
        'comment',
        String(issue),
        '--body',
        `🤖 Der ${roleLabel} (Opus, nur lesend) hat entgegen der Regel Dateien im Arbeitsbaum verändert. Verworfen, kein Commit. Siehe ADR-0005 (Read-only-Netz).`,
      ]);
      tryGh(gh, ['issue', 'edit', String(issue), '--add-label', 'needs-answer']);
      return stop(
        {
          title: `Fehler bei #${issue}`,
          emoji: '🔴',
          text: `🔴 **Fehler bei #${issue}.** Der ${roleLabel} hat unerwartet Dateien geändert — verworfen, kein Commit.

Details stehen als Kommentar am Ticket. Ich fasse #${issue} nicht wieder an, solange \`needs-answer\` hängt.`,
        },
        1,
      );
    }
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
      if (next !== null) {
        return done({
          title: `wartet auf nächsten Lauf · als Nächstes #${next}`,
          emoji: '🟢',
          text: `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #${issue} gearbeitet. Als Nächstes ist **#${next}** dran. Der nächste Takt
startet automatisch (~5 Min) — **kein Eingreifen nötig.**

Offene Queue: ${pending}`,
        });
      }
      return done({
        title: `wartet auf nächsten Lauf · Queue: ${pending}`,
        emoji: '🟢',
        text: `🟢 **Ich warte auf den nächsten Lauf — gerade läuft kein Prozess.**

Zuletzt an #${issue} gearbeitet. In der Queue liegt noch Arbeit (${pending}), aber
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
      state.write('limit-until', String(epoch));
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
