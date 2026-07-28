// Tests fuer die portierte Runde (#203, S6 von #184). Die Runde ist die
// Stelle, an der alle Einzelbausteine zusammenlaufen -- hier wird geprueft,
// welchen Weg ein Takt nimmt und was am Ende im Status steht, nicht mehr, ob
// eine einzelne Hilfsfunktion rechnet (das tun deren eigene Suiten).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createFixedClock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import { createClaimAdapter, type ClaimAdapter } from './claim';
import { roundEval, roundPlan, type RoundContext, type RoundRun } from './round';

const CLOCK = createFixedClock(new Date('2026-07-26T09:22:00'));

function issueJson(number: number, labels: string[], createdAt = '2024-01-01T00:00:00Z') {
  return { number, labels: labels.map((name) => ({ name })), createdAt };
}

/**
 * gh-Double, das auf Aufrufmuster antwortet statt auf Reihenfolge -- so
 * ueberleben die Tests eine geaenderte Aufrufreihenfolge, solange das
 * beobachtbare Verhalten stimmt.
 */
function ghDouble(routes: { match: (args: string[]) => boolean; reply: string }[] = []) {
  const calls: string[][] = [];
  const gh: GhAdapter = {
    run: vi.fn((args: string[]) => {
      calls.push(args);
      const hit = routes.find((route) => route.match(args));
      return hit ? hit.reply : '';
    }),
  };
  return { gh, calls };
}

function called(calls: string[][], ...needles: string[]): boolean {
  return calls.some((args) => needles.every((needle) => args.includes(needle)));
}

function gitDouble(replies: Record<string, string> = {}): GitAdapter {
  return {
    run: vi.fn((args: string[]) => {
      for (const [key, value] of Object.entries(replies)) {
        if (args.join(' ').includes(key)) return value;
      }
      return '';
    }),
  };
}

// Der Rundenschnappschuss: `issue list` OHNE --label. Die Abgrenzung ist
// noetig, weil im selben Lauf auch `pr list --limit 100` (reopen-Netz) und
// `issue list --label needs-answer` (Busy-Meldung) laufen -- ein zu grober Matcher
// beantwortet die mit dem Schnappschuss und laesst Tests aus dem falschen
// Grund scheitern.
const openIssues = (...issues: ReturnType<typeof issueJson>[]) => ({
  match: (args: string[]) =>
    args[0] === 'issue' && args[1] === 'list' && args.includes('--limit') && args.includes('100') && !args.includes('--label'),
  reply: JSON.stringify(issues),
});

const noOpenPrs = { match: (args: string[]) => args[0] === 'pr' && args[1] === 'list', reply: '[]' };

/** `gh issue view N --json labels -q .labels[].name` -- eine Zeile je Label. */
const labelsAre = (...names: string[]) => ({
  match: (args: string[]) => args[0] === 'issue' && args[1] === 'view' && args.includes('labels'),
  reply: names.join('\n'),
});

describe('roundPlan', () => {
  let dir: string;
  let claimsDir: string;
  let state: StateAdapter;
  let claims: ClaimAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'round-'));
    claimsDir = mkdtempSync(join(tmpdir(), 'round-claims-'));
    state = createStateAdapter(dir);
    claims = createClaimAdapter(claimsDir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claimsDir, { recursive: true, force: true });
  });

  function ctx(gh: GhAdapter, git: GitAdapter = gitDouble()): RoundContext {
    // roundPlan schreibt/liest 'sharedState' nirgends -- derselbe Adapter reicht.
    return { gh, git, state, sharedState: state, claims, slotId: '1', clock: CLOCK };
  }

  // isLead: true -- die meisten bestehenden Faelle testen das Verhalten VOR
  // #204 (ein Slot, das war immer der Leitslot). Die eigene Slot/Lead-Logik
  // hat ihre eigene Gruppe weiter unten.
  const opts = { queueIssue: 0, maxRuntime: 2700, didWork: false, lastIssue: '', isLead: true };

  it('meldet ⚪️ nichts zu tun, wenn kein Ticket wartet', () => {
    const { gh } = ghDouble([openIssues(), noOpenPrs]);
    const result = roundPlan(ctx(gh), opts);
    expect(result.kind).toBe('done');
    expect(result.status?.emoji).toBe('⚪️');
    expect(result.status?.title).toBe('nichts zu tun');
  });

  // Ein Ticket, das bei DIR liegt, darf nie als "nichts zu tun" erscheinen --
  // sonst uebersieht man es auf dem Handy.
  it('meldet 🟡 statt ⚪️, wenn eine Frage offen ist', () => {
    const { gh } = ghDouble([openIssues(issueJson(77, ['needs-answer'])), noOpenPrs]);
    const result = roundPlan(ctx(gh), opts);
    expect(result.status?.emoji).toBe('🟡');
    expect(result.status?.title).toContain('#77');
    // #296: der Takt ist seit dem 26.07.26 60 Sekunden, nicht 5 Minuten.
    expect(result.status?.text).toContain('60 Sekunden');
  });

  // #61: eine fruehere Runde hat gearbeitet -> "nichts zu tun" waere gelogen.
  it('meldet 🟢 statt ⚪️, wenn dieser Tick schon produktiv war', () => {
    const { gh } = ghDouble([openIssues(), noOpenPrs]);
    const result = roundPlan(ctx(gh), { ...opts, didWork: true, lastIssue: '42' });
    expect(result.status?.emoji).toBe('🟢');
    expect(result.status?.text).toContain('Zuletzt an #42 gearbeitet');
  });

  it('waehlt ein ready-Ticket und baut den Bau-Prompt', () => {
    const { gh } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs]);
    const result = roundPlan(ctx(gh), opts);
    expect(result.kind).toBe('run');
    const run = result as RoundRun;
    expect(run.issue).toBe(77);
    expect(run.role).toBe('build');
    expect(run.model).toBe('sonnet');
    expect(run.prompt).toContain('Arbeite an Issue #77');
    expect(run.tools).toContain('Write');
    expect(run.status.emoji).toBe('🟠');
    // #273 AC5: die Stufe steht im Titel, weil nur der in der Issue-Liste
    // sichtbar ist -- sonst ist vom Handy aus nicht erkennbar, dass der
    // naechste Lauf Opus verbrennt.
    expect(run.status.title).toBe('arbeitet an #77 (sonnet, seit 09:22)');
  });

  it('gibt der Planer-Rolle Opus und eine nur lesende Allowlist (ADR-0005)', () => {
    const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.role).toBe('plan');
    expect(run.model).toBe('opus');
    expect(run.tools).not.toContain('Write');
    expect(run.prompt).toContain('als **Planer**');
    expect(run.status.title).toContain('plant #80');
  });

  // #326: Anlass war #216 am 28.07.26 -- zwei Plan-Laeufe waren gleichzeitig
  // unterwegs und legten dieselben drei Bau-Tickets doppelt an. Der Claim
  // (#204) schuetzte bis dahin nachweislich nur die Bau-Rolle; fuer plan/
  // research gab es hier noch keine Deckung. Beide Slots teilen sich dieselbe
  // `claims`-Instanz (wie SHARED_DIR im echten Lauf), nur `slotId` unterscheidet
  // sie.
  describe('Claim-Schutz fuer Denk-Rollen (#204, #326)', () => {
    it('beansprucht das Ticket fuer den eigenen Slot, wenn die Planer-Rolle startet', () => {
      const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      roundPlan(ctx(gh), opts);
      expect(claims.readSlot(80)).toBe('1');
    });

    // Slot 2 sieht #80 gar nicht erst als waehlbar -- `claimedElsewhere()`
    // wirft es schon vor der Auswahl-Kaskade raus (wie bei der Bau-Rolle seit
    // #204). Kein zweiter `claude`-Lauf startet, der Claim von Slot 1 bleibt
    // unangetastet.
    it('laesst einen zweiten Slot denselben Plan-Lauf nicht gleichzeitig beginnen', () => {
      const { gh: ghSlot1 } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      roundPlan(ctx(ghSlot1), opts);
      expect(claims.readSlot(80)).toBe('1');

      const { gh: ghSlot2 } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      const ctxSlot2: RoundContext = { gh: ghSlot2, git: gitDouble(), state, sharedState: state, claims, slotId: '2', clock: CLOCK };
      const result = roundPlan(ctxSlot2, opts);

      // 'done' ohne 🟠 heisst: kein zweiter `claude`-Aufruf fuer #80 -- waere
      // Slot 2 fuendig geworden, stuende hier der Busy-Status ("Plant gerade").
      expect(result.kind).toBe('done');
      expect(result.status?.emoji).not.toBe('🟠');
      // Der Claim bleibt beim ersten Slot -- der zweite hat ihn nicht ueberschrieben.
      expect(claims.readSlot(80)).toBe('1');
    });

    it('laesst einen zweiten Slot denselben Recherche-Lauf nicht gleichzeitig beginnen', () => {
      const { gh: ghSlot1 } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
      roundPlan(ctx(ghSlot1), opts);
      expect(claims.readSlot(81)).toBe('1');

      const { gh: ghSlot2 } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
      const ctxSlot2: RoundContext = { gh: ghSlot2, git: gitDouble(), state, sharedState: state, claims, slotId: '2', clock: CLOCK };
      const result = roundPlan(ctxSlot2, opts);

      expect(result.kind).toBe('done');
      expect(claims.readSlot(81)).toBe('1');
    });
  });

  // --- Startstufe am Ticket (ADR-0013, #273) --------------------------------
  describe('Modellstufe per Label', () => {
    it('AC1: model:opus baut sofort auf Opus, ohne vorherige Eskalation', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(90, ['ready', 'model:opus'])),
        noOpenPrs,
        labelsAre('ready', 'model:opus'),
      ]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.model).toBe('opus');
      expect(run.role).toBe('build');
      // Kein Eskalationszustand noetig -- die Stufe kommt allein aus dem Label.
      expect(state.exists('tier-90')).toBe(false);
    });

    it('AC2: bei der Planer-Rolle schlaegt model:sonnet die Rolle', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(91, ['plan', 'model:sonnet'])),
        noOpenPrs,
        labelsAre('plan', 'model:sonnet'),
      ]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('plan');
      expect(run.model).toBe('sonnet');
      // Der Statustext darf dann nicht weiter "Opus" behaupten.
      expect(run.status.text).toContain('(sonnet, nur lesend)');
    });

    it('AC3: ohne model:*-Label bleibt die Denk-Rolle bei Opus (ADR-0005)', () => {
      const { gh } = ghDouble([openIssues(issueJson(92, ['research'])), noOpenPrs, labelsAre('research')]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.model).toBe('opus');
    });

    it('AC5: der Titel nennt die eskalierte Stufe, nicht die Startstufe', () => {
      state.write('tier-93', 'opus');
      const { gh } = ghDouble([
        openIssues(issueJson(93, ['ready', 'model:sonnet'])),
        noOpenPrs,
        labelsAre('ready', 'model:sonnet'),
      ]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.model).toBe('opus');
      expect(run.status.title).toBe('arbeitet an #93 (opus, seit 09:22)');
    });

    it('AC6: der Opus-Tagesdeckel greift auch bei hand-gesetztem model:opus', () => {
      state.write('opus-build-20260726-94', '2');
      const { gh, calls } = ghDouble([
        openIssues(issueJson(94, ['ready', 'model:opus'])),
        noOpenPrs,
        labelsAre('ready', 'model:opus'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Opus-Tagesbudget');
      expect(called(calls, 'edit', '94', '--add-label', 'blocked-limit')).toBe(true);
    });

    it('no-escalation friert auf der gesetzten Startstufe ein, nicht pauschal auf Sonnet', () => {
      state.write('tier-95', 'opus');
      const { gh } = ghDouble([
        openIssues(issueJson(95, ['ready', 'no-escalation', 'model:haiku'])),
        noOpenPrs,
        labelsAre('ready', 'no-escalation', 'model:haiku'),
      ]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.model).toBe('haiku');
    });
  });

  it('gibt der Recherche-Rolle zusaetzlich WebSearch', () => {
    const { gh } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.role).toBe('research');
    expect(run.tools).toContain('WebSearch');
    expect(run.tools).not.toContain('Edit');
  });

  // ADR-0007: 'no-escalation' friert auf der Default-Stufe ein, auch wenn
  // bereits eine hoehere Stufe gestempelt ist.
  it('friert das Modell bei no-escalation ein', () => {
    state.write('tier-77', 'opus');
    const { gh } = ghDouble([
      openIssues(issueJson(77, ['ready', 'no-escalation'])),
      noOpenPrs,
      labelsAre('ready', 'no-escalation'),
    ]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.model).toBe('sonnet');
  });

  it('nimmt bei no-escalation + model:haiku Haiku', () => {
    const { gh } = ghDouble([
      openIssues(issueJson(77, ['ready', 'no-escalation', 'model:haiku'])),
      noOpenPrs,
      labelsAre('ready', 'no-escalation', 'model:haiku'),
    ]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.model).toBe('haiku');
  });

  // #272: ein Ticket mit in-progress UND needs-answer wird NICHT mehr
  // umgelabelt -- es behaelt in-progress und wird von der Auswahl schlicht
  // uebersprungen. Genau das ersetzt die fruehere Selbstheilung aus #145.
  it('laesst in-progress + needs-answer unangetastet und waehlt es nicht', () => {
    const { gh, calls } = ghDouble([openIssues(issueJson(50, ['in-progress', 'needs-answer'])), noOpenPrs]);
    const result = roundPlan(ctx(gh), opts);
    expect(called(calls, 'edit', '50', '--remove-label', 'in-progress')).toBe(false);
    expect(result.kind).toBe('done');
  });

  // #19: der Status nennt das Ticket VOR dem Lauf, sonst steht bis zu 45
  // Minuten der Stand des letzten Laufs im Status-Issue.
  it('nennt ein zusaetzlich wartendes Ticket in der Busy-Meldung (#145 AC6)', () => {
    const { gh } = ghDouble([
      openIssues(issueJson(77, ['ready'])),
      noOpenPrs,
      { match: (a) => a.includes('--label') && a.includes('needs-answer'), reply: '#90' },
      labelsAre('ready'),
    ]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.status.text).toContain('Wartet zusätzlich auf dich: #90');
  });

  // #272: Bis S2b lief die Wache ueber 'parked' und promotete ein freigegebenes
  // Ticket zurueck auf 'in-progress'. Jetzt bleibt 'in-progress' die ganze Zeit
  // stehen und nur 'needs-answer' faellt weg. Auf Bausteinebene prueft das
  // watch.test.ts -- hier geht es um die VERDRAHTUNG in der Runde: welcher
  // Snapshot in die Wache geht und was ihr Ergebnis fuer den Rest des Takts
  // bedeutet.
  // --- Queue-Bericht + blocked-by (#265) -----------------------------------
  // Der Runner schreibt Issue 92 NICHT um -- die Liste bleibt die des
  // Menschen. Er meldet nur, was daran erledigt ist, was auf Vorarbeit wartet
  // und was gar nicht gelistet ist. 'blocked-by' setzt und entfernt er selbst.
  describe('Queue-Bericht (#265)', () => {
    const queueOpts = { ...opts, queueIssue: 92 };
    const queueIs = (body: string) => ({
      match: (a: string[]) => a[0] === 'issue' && a[1] === 'view' && a.includes('body'),
      reply: body,
    });

    it('AC1: erledigte Eintraege werden ausgewiesen -- ohne Issue 92 anzufassen', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(300, ['ready'])),
        noOpenPrs,
        queueIs('- #232\n- #252\n- #300'),
        labelsAre('ready'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.status?.text).toContain('kannst du streichen: #232, #252');
      // Kein Schreibzugriff auf das Queue-Issue.
      expect(calls.some((args) => args[0] === 'issue' && args[1] === 'edit' && args[2] === '92')).toBe(false);
      expect(calls.some((args) => args[0] === 'issue' && args[1] === 'comment' && args[2] === '92')).toBe(false);
    });

    it('AC2: ein nicht gelistetes ready-Ticket wird immer genannt', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(300, ['ready']), issueJson(400, ['ready'], '2024-02-01T00:00:00Z')),
        noOpenPrs,
        queueIs('- #300'),
        labelsAre('ready'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.status?.text).toContain('Nicht gelistet, wartet auf einen Platz: #400');
    });

    it('AC4: ein blockiertes Ticket bekommt blocked-by und wird nicht gebaut', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(266, ['ready']), issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z')),
        noOpenPrs,
        queueIs('- #266 nach #227'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(called(calls, 'edit', '266', '--add-label', 'blocked-by')).toBe(true);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Wartet auf Vorarbeit: #266 (nach #227)');
    });

    it('AC5: faellt die Voraussetzung weg, nimmt der Runner blocked-by von selbst ab', () => {
      // #227 ist geschlossen -> nicht mehr im Snapshot.
      const { gh, calls } = ghDouble([
        openIssues(issueJson(266, ['ready', 'blocked-by'])),
        noOpenPrs,
        queueIs('- #266 nach #227'),
        labelsAre('ready'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(called(calls, 'edit', '266', '--remove-label', 'blocked-by')).toBe(true);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).issue).toBe(266);
    });

    it('setzt blocked-by nicht doppelt, wenn es schon haengt', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(266, ['ready', 'blocked-by']), issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z')),
        noOpenPrs,
        queueIs('- #266 nach #227'),
      ]);
      roundPlan(ctx(gh), queueOpts);
      expect(called(calls, 'edit', '266', '--add-label', 'blocked-by')).toBe(false);
    });

    it('AC6: ein Zirkel wird gemeldet und keins der Tickets gebaut', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(1, ['ready']), issueJson(2, ['ready'], '2024-02-01T00:00:00Z')),
        noOpenPrs,
        queueIs('- #1 nach #2\n- #2 nach #1'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Zirkel in der Queue:** #1, #2');
    });

    it('ohne Queue-Eintraege bleibt der Statustext unveraendert', () => {
      const { gh } = ghDouble([openIssues(issueJson(300, ['ready'])), noOpenPrs, queueIs(''), labelsAre('ready')]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.status?.text).not.toContain('Nicht gelistet');
      expect(result.status?.text).not.toContain('Wartet auf Vorarbeit');
    });
  });

  // #296: "Queue" faellt nur noch, wenn #92 tatsaechlich Eintraege hat --
  // vorher hiess selbst ein rein per Label offenes hands-off-Ticket "Queue",
  // obwohl #92 leer war.
  describe('Wortlaut Queue vs. Offen im Status (#296)', () => {
    const queueOpts = { ...opts, queueIssue: 92 };
    const queueIs = (body: string) => ({
      match: (a: string[]) => a[0] === 'issue' && a[1] === 'view' && a.includes('body'),
      reply: body,
    });
    // queuePending() holt sich ueber queueSnapshot() einen EIGENEN Schnappschuss
    // (--limit 50, nicht 100 wie der Runden-Schnappschuss) -- ohne diese
    // zusaetzliche Route bleibt die Antwort leer und `pending` faelschlich ''.
    const openIssues50 = (...issues: ReturnType<typeof issueJson>[]) => ({
      match: (a: string[]) => a[0] === 'issue' && a[1] === 'list' && a.includes('--limit') && a.includes('50'),
      reply: JSON.stringify(issues),
    });

    it('#92 leer + hands-off-Ticket: "Offen", nicht "Queue"', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(204, ['plan', 'hands-off'])),
        openIssues50(issueJson(204, ['plan', 'hands-off'])),
        noOpenPrs,
        queueIs(''),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.kind).toBe('done');
      expect(result.status?.title).toBe('wartet auf nächsten Lauf · Offen: #204');
      expect(result.status?.title).not.toContain('Queue');
      expect(result.status?.text).toContain('Offen ist noch Arbeit (#204)');
    });

    it('#92 mit echtem Eintrag: das Wort "Queue" darf fallen', () => {
      const issues = [issueJson(266, ['ready']), issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z')];
      const { gh } = ghDouble([
        openIssues(...issues),
        openIssues50(...issues),
        noOpenPrs,
        queueIs('- #266 nach #227'),
      ]);
      const result = roundPlan(ctx(gh), queueOpts);
      expect(result.kind).toBe('done');
      expect(result.status?.title).toBe('wartet auf nächsten Lauf · Queue: #266');
      expect(result.status?.text).toContain('In der Queue liegt noch Arbeit (#266)');
    });
  });

  describe('CI-Wache fuer wartende Tickets (#154, #272)', () => {
    // Beantwortet alles, was prForIssue/prCiState/prSquashMerge fuer EIN
    // wartendes Ticket brauchen. `pr view` muss nach Feld unterscheiden:
    // Merge-Zustand ist JSON, der Titel ist eine nackte Zeile.
    const waitingPr = (issue: number, pr: number, checks: { bucket: string; name: string }[]) => [
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'list',
        reply: JSON.stringify([{ number: pr, title: `feat: x — Closes #${issue}`, headRefName: `feat/${issue}-x` }]),
      },
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'checks' && a[2] === String(pr),
        reply: JSON.stringify(checks),
      },
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus'),
        reply: JSON.stringify({ headRefName: `feat/${issue}-x`, mergeStateStatus: 'CLEAN' }),
      },
      { match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('.title'), reply: 'feat: x' },
    ];

    const green = [{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }];

    it('gruener PR eines wartenden Tickets: Merge, needs-answer weg, Hinweis im Status', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(90, ['in-progress', 'needs-answer'])),
        ...waitingPr(90, 690, green),
        labelsAre('in-progress'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '90', '--remove-label', 'needs-answer')).toBe(true);
      expect(result.status?.text).toContain('#90');
      expect(result.status?.text).toContain('freigegeben');
    });

    // Der Snapshot wird nach der Freigabe umgeschrieben (statt neu geladen),
    // damit derselbe Takt das Ticket nicht noch als wartend behandelt: es
    // faellt in den running-Zweig und damit unter die CI-Wache fuer laufende
    // Tickets. Ohne das Umschreiben stuende bis zum naechsten Takt "wartet auf
    // dich" im Status-Issue, obwohl gerade nichts mehr bei dir liegt.
    it('das freigegebene Ticket gilt im SELBEN Takt nicht mehr als wartend', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(90, ['in-progress', 'needs-answer'])),
        ...waitingPr(90, 690, green),
        labelsAre('in-progress'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.emoji).not.toBe('🟡');
      expect(result.status?.title).not.toContain('wartet auf dich');
    });

    it('pendender PR: keine Freigabe, kein Hinweis, das Ticket bleibt wartend', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(91, ['in-progress', 'needs-answer'])),
        ...waitingPr(91, 691, [{ bucket: 'pass', name: 'quality' }, { bucket: 'pending', name: 'e2e' }]),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '91', '--remove-label', 'needs-answer')).toBe(false);
      expect(result.status?.text).not.toContain('freigegeben');
      expect(result.status?.emoji).toBe('🟡');
    });

    // #272 hat den Bauplatz-Vorbehalt gestrichen: frueher gab die Wache
    // hoechstens EIN Ticket frei, weil ein entparktes Ticket sofort einen
    // Bauplatz belegt haette. Ohne Parken ist das gegenstandslos.
    it('zwei gruene wartende Tickets werden beide freigegeben und beide genannt', () => {
      const { gh, calls } = ghDouble([
        openIssues(
          issueJson(92, ['in-progress', 'needs-answer']),
          issueJson(93, ['ready', 'needs-answer'], '2024-02-01T00:00:00Z'),
        ),
        {
          match: (a: string[]) => a[0] === 'pr' && a[1] === 'list',
          reply: JSON.stringify([
            { number: 692, title: 'feat: a', headRefName: 'feat/92-a' },
            { number: 693, title: 'feat: b', headRefName: 'feat/93-b' },
          ]),
        },
        { match: (a: string[]) => a[0] === 'pr' && a[1] === 'checks', reply: JSON.stringify(green) },
        {
          match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus'),
          reply: JSON.stringify({ headRefName: 'feat/92-a', mergeStateStatus: 'CLEAN' }),
        },
        { match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('.title'), reply: 'feat: a' },
        labelsAre('in-progress'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '92', '--remove-label', 'needs-answer')).toBe(true);
      expect(called(calls, 'edit', '93', '--remove-label', 'needs-answer')).toBe(true);
      expect(result.status?.text).toContain('#92, #93');
    });
  });

  describe('CI-Wache fuer ein laufendes Ticket (#147)', () => {
    const withPr = (issue: number, labels: string[], checks: string) => [
      openIssues(issueJson(issue, labels)),
      {
        // Das reopen-Netz fragt `pr list --json number,title`, prForIssue
        // `--json number,headRefName` -- eine Antwort bedient beide.
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'list',
        reply: JSON.stringify([{ number: 5, title: 'feat: x', headRefName: `feat/${issue}-x` }]),
      },
      { match: (a: string[]) => a.includes('checks'), reply: checks },
      labelsAre(...labels),
    ];

    it('wartet gruen, solange die Checks laufen -- ohne Agentenlauf', () => {
      const { gh } = ghDouble(withPr(77, ['in-progress'], JSON.stringify([{ bucket: 'pending', name: 'e2e' }])));
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.emoji).toBe('🟢');
      expect(result.status?.text).toContain('CI läuft für #77');
    });

    // #324: der Anlass des Tickets -- ein Check haengt seit Stunden auf
    // 'pending', der Status meldet trotzdem gruen "kein Eingreifen noetig".
    // Ab PENDING_STALL_MINUTES kippt derselbe Zustand auf gelb, mit
    // Ticketnummer und Dauer im Text (AC2/AC5).
    it('#324: haengt der Check laenger als die Schwelle, kippt der Status von gruen auf gelb', () => {
      state.write('pending-since-77', String(CLOCK.now().getTime() - 46 * 60_000));
      const { gh } = ghDouble(withPr(77, ['in-progress'], JSON.stringify([{ bucket: 'pending', name: 'e2e' }])));
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.emoji).toBe('🟡');
      expect(result.status?.title).toContain('#77');
      expect(result.status?.title).toContain('46 Minuten');
      expect(result.status?.text).toContain('#77');
      expect(result.status?.text).toContain('46 Minuten');
    });

    // #324 AC3: unterhalb der Schwelle bleibt alles wie bisher, auch wenn
    // schon eine Weile gewartet wird -- keine neue Unruhe fuer normale Laeufe.
    it('#324 AC3: unterhalb der Schwelle bleibt es beim bisherigen gruen', () => {
      state.write('pending-since-77', String(CLOCK.now().getTime() - 10 * 60_000));
      const { gh } = ghDouble(withPr(77, ['in-progress'], JSON.stringify([{ bucket: 'pending', name: 'e2e' }])));
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.emoji).toBe('🟢');
      expect(result.status?.text).toContain('CI läuft für #77');
    });
  });

  describe('Opus-Bau-Deckel (ADR-0007)', () => {
    it('haelt das Ticket an, wenn das Tagesbudget erschoepft ist', () => {
      state.write('tier-77', 'opus');
      state.write('opus-build-20260726-77', '2');
      const { gh, calls } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.emoji).toBe('🟡');
      expect(result.status?.title).toBe('Opus-Deckel (#77)');
      expect(result.status?.text).toContain('Opus-Tagesbudget');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
    });

    // #272: der Deckel wartet auf ZEIT, nicht auf eine geschriebene Antwort --
    // morgen laeuft er von selbst weiter. Mit nur noch einem Wartelabel waere
    // 'needs-answer' hier eine Luege im Status-Issue: es wuerde den Menschen
    // zu einer Antwort auffordern, die niemand braucht.
    it('setzt dabei KEIN Wartelabel -- niemand ist gefragt', () => {
      state.write('tier-77', 'opus');
      state.write('opus-build-20260726-77', '2');
      const { gh, calls } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '77', '--add-label', 'needs-answer')).toBe(false);
      expect(result.status?.text).toContain('von selbst weiter');
    });

    // #283 (Entscheidung aus #278): Der Titel hiess "wartet auf dich (#N)" --
    // das behauptete eine Bringschuld, die es nicht gibt: der Deckel setzt
    // 'blocked-limit' und laeuft morgen von selbst weiter. 🟡 bleibt, weil die
    // Eskalation oben klemmt und nur ein Mensch das aufloest.
    it('nennt sich im Titel Opus-Deckel, nicht "wartet auf dich"', () => {
      state.write('tier-77', 'opus');
      state.write('opus-build-20260726-77', '2');
      const { gh } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.title).toBe('Opus-Deckel (#77)');
      expect(result.status?.emoji).toBe('🟡');
    });

    // #136: die Meldung darf hoechstens einmal je Ticket und Tag erscheinen.
    it('kommentiert den Deckel nur einmal pro Ticket und Tag', () => {
      state.write('tier-77', 'opus');
      state.write('opus-build-20260726-77', '2');
      state.write('opus-cap-msg-20260726-77', '');
      const { gh, calls } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      roundPlan(ctx(gh), opts);
      expect(called(calls, 'comment', '77')).toBe(false);
    });
  });
});

describe('roundEval', () => {
  let dir: string;
  let sharedDir: string;
  let state: StateAdapter;
  let sharedState: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'round-eval-'));
    sharedDir = mkdtempSync(join(tmpdir(), 'round-eval-shared-'));
    state = createStateAdapter(dir);
    sharedState = createStateAdapter(sharedDir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  });

  const plan: RoundRun = {
    kind: 'run',
    status: { title: '', emoji: '', text: '' },
    issue: 77,
    role: 'build',
    model: 'sonnet',
    tools: '',
    resume: '',
    labels: 'ready ',
    beforeTip: 'abc',
    queueBody: '',
    didWork: false,
    lastIssue: '',
    prompt: '',
  };

  // roundEval liest/schreibt weder 'claims' noch 'slotId' -- Platzhalter reicht.
  const claims = createClaimAdapter(mkdtempSync(join(tmpdir(), 'round-eval-claims-')));

  function ctx(gh: GhAdapter, git: GitAdapter = gitDouble()): RoundContext {
    return { gh, git, state, sharedState, claims, slotId: '1', clock: CLOCK };
  }

  const ok = { rc: 0, out: '{"session_id":"sid-1","result":"ok"}', timedOut: false, maxRuntime: 2700 };

  it('sichert die Session-ID eines sauberen Laufs', () => {
    const { gh } = ghDouble();
    roundEval(ctx(gh), plan, ok, '');
    expect(state.read('session-77')).toBe('sid-1');
  });

  // #64: nach einem Timeout-Kill ist die Ausgabe kein valides JSON -- die noch
  // gueltige alte ID darf dann nicht ueberschrieben werden.
  it('ueberschreibt die alte Session-ID nicht mit Leere', () => {
    state.write('session-77', 'sid-alt');
    const { gh } = ghDouble();
    roundEval(ctx(gh), plan, { ...ok, rc: 1, out: 'kaputt' }, '');
    expect(state.read('session-77')).toBe('sid-alt');
  });

  // Gegenstueck zum Deckel oben: 'blocked-limit' ist ein Zeit-Label, das kein
  // Mensch abnimmt. Kommt ueberhaupt ein Lauf zustande, ist die Sperre vorbei
  // -- bliebe das Label haengen, stuende das Ticket dauerhaft als blockiert im
  // Status-Issue, obwohl gerade daran gebaut wird.
  it('nimmt ein stehengebliebenes blocked-limit wieder ab', () => {
    const { gh, calls } = ghDouble();
    roundEval(ctx(gh), plan, ok, '');
    expect(called(calls, 'edit', '77', '--remove-label', 'blocked-limit')).toBe(true);
  });

  it('setzt die Chain nur nach einem sauberen Lauf ohne offene Frage fort (#61)', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, ok, '');
    expect(result.chain).toBe('continue');
    expect(result.didWork).toBe(true);
    expect(result.lastIssue).toBe('77');
    expect(result.rc).toBe(0);
  });

  it('stoppt die Chain, wenn der Agent an DIESEM Ticket gefragt hat', () => {
    const { gh, calls } = ghDouble([{ match: (a) => a.includes('labels'), reply: 'ready\nneeds-answer' }]);
    const result = roundEval(ctx(gh), plan, ok, '');
    expect(result.chain).toBe('stop');
    expect(result.status?.emoji).toBe('🟡');
    // #272: kein Umlabeln mehr -- das Ticket behaelt 'in-progress' und wird
    // allein durch 'needs-answer' aus der Auswahl gehalten.
    expect(called(calls, 'edit', '77', '--remove-label', 'in-progress')).toBe(false);
  });

  describe('Limit (429)', () => {
    const limited = {
      rc: 1,
      out: '{"api_error_status":429,"result":"5-hour limit reached ∙ resets 3pm"}',
      timedOut: false,
      maxRuntime: 2700,
    };

    it('pausiert blau, setzt blocked-limit und schreibt limit-until ins sharedState, NICHT ins slot-lokale state', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh), plan, limited, '');
      expect(result.status?.emoji).toBe('🔵');
      expect(result.rc).toBe(0); // kein Fehler -- der Timer probiert es wieder
      expect(result.chain).toBe('stop');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
      expect(sharedState.read('limit-until')).not.toBeNull();
      expect(state.read('limit-until')).toBeNull();
    });

    // #204: das Kontingent ist EINS, nicht pro Slot. Schriebe roundEval hier
    // in ein slot-lokales 'state', rennte ein zweiter Slot mit eigenem
    // STATE_DIR weiter in 429er, waehrend dieser korrekt pausiert -- und zwar
    // schweigend, weil das Bash-Gate '$SHARED_DIR/limit-until' liest, eine
    // Datei, die dann nie jemand geschrieben haette.
    it('macht limit-until für einen zweiten Slot mit eigenem STATE_DIR sichtbar (#204)', () => {
      const slotA = createStateAdapter(mkdtempSync(join(tmpdir(), 'slot-a-')));
      const slotB = createStateAdapter(mkdtempSync(join(tmpdir(), 'slot-b-')));
      const { gh } = ghDouble();
      roundEval({ gh, git: gitDouble(), state: slotA, sharedState, claims, slotId: '1', clock: CLOCK }, plan, limited, '');
      expect(slotA.read('limit-until')).toBeNull();
      expect(slotB.read('limit-until')).toBeNull();
      // Slot B liest denselben SHARED_DIR wie Slot A -- und sieht die Pause.
      expect(sharedState.read('limit-until')).not.toBeNull();
    });

    // Ein unbekannter Limit-Wortlaut darf den Runner nie stilllegen -- er
    // laeuft im 5-Minuten-Takt weiter und der Wortlaut wird mitgeschrieben.
    it('protokolliert einen undeutbaren Limit-Text statt zu pausieren', () => {
      const { gh } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        { ...limited, out: '{"api_error_status":429,"result":"nicht deutbar"}' },
        '',
      );
      expect(sharedState.read('limit-until')).toBeNull();
      expect(state.read('unparsed-limits.log')).toContain('nicht deutbar');
      expect(result.status?.text).toContain('in ~5 Minuten');
    });
  });

  it('meldet die Notbremse blau und ohne needs-answer', () => {
    const { gh, calls } = ghDouble();
    const result = roundEval(ctx(gh), plan, { ...ok, rc: 143, timedOut: true }, '');
    expect(result.status?.emoji).toBe('🔵');
    expect(result.status?.text).toContain('Notbremse');
    expect(result.rc).toBe(0);
    expect(called(calls, '--add-label', 'needs-answer')).toBe(false);
  });

  describe('voruebergehender API-Fehler', () => {
    const transient = { rc: 1, out: '{"api_error_status":503}', timedOut: false, maxRuntime: 2700 };

    it('zaehlt hoch und wartet auf den naechsten Takt', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh), plan, transient, '');
      expect(result.status?.text).toContain('Versuch 1 von 3');
      expect(result.rc).toBe(0);
      expect(state.read('transient-77')).toBe('1');
      expect(called(calls, '--add-label', 'needs-answer')).toBe(false);
    });

    it('eskaliert beim dritten Mal in Folge auf rot', () => {
      state.write('transient-77', '2');
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh), plan, transient, '');
      expect(result.status?.emoji).toBe('🔴');
      expect(result.rc).toBe(1);
      expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
      expect(state.read('transient-77')).toBeNull();
    });

    it('setzt den Zaehler nach einem sauberen Lauf zurueck', () => {
      state.write('transient-77', '2');
      const { gh } = ghDouble();
      roundEval(ctx(gh), plan, ok, '');
      expect(state.read('transient-77')).toBeNull();
    });
  });

  // ADR-0005: das Netz greift unabhaengig vom Exit-Code -- auch ein
  // "erfolgreicher" Denk-Lauf darf den Arbeitsbaum nicht beschmutzen.
  describe('Read-only-Netz fuer Denk-Rollen (ADR-0005 + #63)', () => {
    it('verwirft Aenderungen eines Planer-Laufs und meldet rot', () => {
      const git = gitDouble({ 'status --porcelain': ' M src/ui/shell.css' });
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh, git), { ...plan, role: 'plan' }, ok, '');
      expect(result.status?.emoji).toBe('🔴');
      expect(result.rc).toBe(1);
      expect(git.run).toHaveBeenCalledWith(['checkout', '--', '.']);
      expect(git.run).toHaveBeenCalledWith(['clean', '-fd']);
      expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
    });

    it('laesst einen sauberen Bau-Lauf mit Aenderungen in Ruhe', () => {
      const git = gitDouble({ 'status --porcelain': ' M src/ui/shell.css' });
      const { gh } = ghDouble();
      const result = roundEval(ctx(gh, git), plan, ok, '');
      expect(result.chain).toBe('continue');
      expect(git.run).not.toHaveBeenCalledWith(['clean', '-fd']);
    });
  });

  it('meldet einen inhaltlichen Fehlschlag rot und setzt needs-answer', () => {
    const { gh, calls } = ghDouble();
    const result = roundEval(ctx(gh), plan, { rc: 2, out: '{}', timedOut: false, maxRuntime: 2700 }, 'letzte Zeile');
    expect(result.status?.emoji).toBe('🔴');
    expect(result.rc).toBe(1);
    expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
    expect(calls.some((args) => args.join(' ').includes('letzte Zeile'))).toBe(true);
  });
});
