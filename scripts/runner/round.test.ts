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
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'round-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ctx(gh: GhAdapter, git: GitAdapter = gitDouble()): RoundContext {
    return { gh, git, state, clock: CLOCK };
  }

  const opts = { queueIssue: 0, maxRuntime: 2700, didWork: false, lastIssue: '' };

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
    expect(run.status.title).toBe('arbeitet an #77 (seit 09:22)');
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
  });

  describe('Opus-Bau-Deckel (ADR-0007)', () => {
    it('haelt das Ticket an, wenn das Tagesbudget erschoepft ist', () => {
      state.write('tier-77', 'opus');
      state.write('opus-build-20260726-77', '2');
      const { gh, calls } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.emoji).toBe('🟡');
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
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'round-eval-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  function ctx(gh: GhAdapter, git: GitAdapter = gitDouble()): RoundContext {
    return { gh, git, state, clock: CLOCK };
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

    it('pausiert blau, setzt blocked-limit und schreibt limit-until', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh), plan, limited, '');
      expect(result.status?.emoji).toBe('🔵');
      expect(result.rc).toBe(0); // kein Fehler -- der Timer probiert es wieder
      expect(result.chain).toBe('stop');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
      expect(state.read('limit-until')).not.toBeNull();
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
      expect(state.read('limit-until')).toBeNull();
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
