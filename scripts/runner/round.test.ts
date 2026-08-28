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
import { roundEval, roundPlan, roundRecover, type RoundContext, type RoundRun } from './round';
import { CHECK_TOOLS, READONLY_DENY } from './prompts';
import { READONLY_TOOLS } from './prompts';

const CLOCK = createFixedClock(new Date('2026-07-26T09:22:00'));

// #839: Der Standard-Body traegt Akzeptanzkriterien, weil das AK-Tor in
// roundPlan() ein Ticket ohne sie gar nicht erst bauen laesst. Ein Fixture ohne
// AK ist seit #839 kein neutraler Platzhalter mehr, sondern ein kaputtes
// Ticket -- wer genau das pruefen will, uebergibt body explizit als ''.
const AK_BODY = '## Akzeptanzkriterien\n\n1. Es tut, was im Titel steht.';

function issueJson(number: number, labels: string[], createdAt = '2024-01-01T00:00:00Z', body = AK_BODY) {
  return { number, labels: labels.map((name) => ({ name })), createdAt, body };
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
    // Die meisten Faelle hier pruefen nicht, WELCHER Adapter getroffen wird --
    // derselbe reicht. #484: die eigene Gruppe unten prueft state/sharedState
    // bewusst getrennt.
    return { gh, git, state, sharedState: state, claims, slotId: '1', clock: CLOCK };
  }

  // isLead: true -- die meisten bestehenden Faelle testen das Verhalten VOR
  // #204 (ein Slot, das war immer der Leitslot). Die eigene Slot/Lead-Logik
  // hat ihre eigene Gruppe weiter unten.
  const opts = { statusIssue: 0, maxRuntime: 2700, didWork: false, lastIssue: '', isLead: true };

  // #839: das AK-Tor und die Pruef-Rolle. Beide Richtungen sind hier teuer und
  // deshalb einzeln festgenagelt -- ein Tor, das zu frueh zuschlaegt, parkt die
  // Flotte; eines, das nie zuschlaegt, ist Dekoration.
  describe('AK-Tor und Pruef-Rolle (#839)', () => {
    const noAk = '## Ziel\n\nEin Satz, aber keine Kriterien.';
    const lsRemote = { 'ls-remote': 'abc123\trefs/heads/feat/70-quick-add\n' };

    it('startet keinen Bau-Lauf fuer ein Ticket ohne Akzeptanzkriterien', () => {
      const { gh, calls } = ghDouble([openIssues(issueJson(70, ['ready'], '2024-01-01T00:00:00Z', noAk)), noOpenPrs]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(called(calls, 'comment', '70')).toBe(true);
      expect(called(calls, 'edit', '70', '--add-label', 'needs-answer')).toBe(true);
      expect(result.status?.title).toContain('keine AK');
    });

    it('baut, sobald der Abschnitt da ist', () => {
      const { gh } = ghDouble([openIssues(issueJson(70, ['ready'])), noOpenPrs, labelsAre('ready')]);
      expect(roundPlan(ctx(gh), opts).kind).toBe('run');
    });

    // Fail open: ein Schnappschuss ohne 'body' heisst "unbekannt", nicht "leer".
    // Ein Tor, das auf fehlende Information hin parkt, legt die Flotte still.
    it('greift nicht, wenn der Schnappschuss gar kein body-Feld traegt', () => {
      // JSON.stringify wirft `undefined` weg -- die Antwort traegt also gar
      // kein 'body'-Feld, genau wie ein aelterer Aufrufer es liefern wuerde.
      const bodyless = { ...issueJson(70, ['ready']), body: undefined } as unknown as ReturnType<typeof issueJson>;
      const { gh, calls } = ghDouble([openIssues(bodyless), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('run');
      expect(called(calls, 'edit', '70', '--add-label', 'needs-answer')).toBe(false);
    });

    it('greift nicht bei plan -- die Denk-Rollen sollen die Kriterien erst schreiben', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(70, ['plan'], '2024-01-01T00:00:00Z', noAk)),
        noOpenPrs,
        labelsAre('plan'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).role).toBe('plan');
      expect(called(calls, 'edit', '70', '--add-label', 'needs-answer')).toBe(false);
    });

    it('startet den Pruef-Lauf nur lesend, auf Sonnet, mit Kriterien und Branch', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(70, ['in-progress', 'check'])),
        noOpenPrs,
        labelsAre('in-progress', 'check'),
      ]);
      const result = roundPlan(ctx(gh, gitDouble(lsRemote)), opts) as RoundRun;
      expect(result.kind).toBe('run');
      expect(result.role).toBe('check');
      expect(result.model).toBe('sonnet');
      expect(result.tools).toBe(CHECK_TOOLS);
      expect(result.denyTools).toBe(READONLY_DENY);
      expect(result.branch).toBe('feat/70-quick-add');
      expect(result.prompt).toContain('1. Es tut, was im Titel steht.');
    });

    // Die Eskalation aus ADR-0007 gilt dem Bauen, nicht dem Nachsehen.
    it('hebt den Pruefer nicht auf die Eskalationsstufe des Bau-Tickets', () => {
      state.write('tier-70', 'opus');
      const { gh } = ghDouble([
        openIssues(issueJson(70, ['in-progress', 'check'])),
        noOpenPrs,
        labelsAre('in-progress', 'check'),
      ]);
      expect((roundPlan(ctx(gh, gitDouble(lsRemote)), opts) as RoundRun).model).toBe('sonnet');
    });

    it('folgt aber einem model:*-Label am Ticket', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(70, ['in-progress', 'check', 'model:opus'])),
        noOpenPrs,
        labelsAre('in-progress', 'check', 'model:opus'),
      ]);
      expect((roundPlan(ctx(gh, gitDouble(lsRemote)), opts) as RoundRun).model).toBe('opus');
    });

    // Das Tor haelt nur, wenn die CI-Wache dem Pruefer nicht zuvorkommt: sie
    // laeuft im selben Takt und mergte bis hierher JEDEN gruenen PR selbst --
    // der Bau-Lauf endet gruen, setzt 'check', und der naechste Takt haette
    // gemergt, bevor je ein Pruefer gelaufen waere.
    // #880: der PR eines Tickets, das auf sein AK-Tor wartet, ist ein Entwurf
    // (`isDraft: true`) -- kein Pruefer hat ihn je freigegeben. Genau daran
    // haengt der Riegel jetzt, nicht mehr am Label 'check'.
    const prRoutes = (issue: number, labels: string[], checks: string, isDraft = true) => [
      openIssues(issueJson(issue, labels)),
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'list',
        reply: JSON.stringify([{ number: 5, title: 'feat: x', headRefName: `feat/${issue}-x` }]),
      },
      { match: (a: string[]) => a.includes('checks'), reply: checks },
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus,isDraft'),
        reply: JSON.stringify({ headRefName: `feat/${issue}-x`, mergeStateStatus: 'CLEAN', isDraft }),
      },
      { match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('.title'), reply: 'feat: x' },
      labelsAre(...labels),
    ];
    const greenChecks = JSON.stringify([{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }]);
    const redChecks = JSON.stringify([{ bucket: 'fail', name: 'e2e', description: '1 rot' }]);

    it('mergt einen gruenen Entwurfs-PR nicht, sondern startet den Pruef-Lauf (#880)', () => {
      const { gh, calls } = ghDouble(prRoutes(70, ['in-progress', 'check'], greenChecks));
      const result = roundPlan(ctx(gh, gitDouble(lsRemote)), opts);
      expect(called(calls, 'pr', 'ready')).toBe(false);
      expect(called(calls, 'pr', 'merge')).toBe(false);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).role).toBe('check');
    });

    // #880 AC1/AC4: der Rueckweg aus dem Check ist dicht. Der Pruefer nahm bei
    // einer Luecke 'check' ab -- der PR bleibt aber Entwurf. Ohne Label sah die
    // alte Wache einen gruenen PR und mergte ihn (die Luecke aus #850). Jetzt
    // greift der Riegel am Entwurfsstatus: kein Merge, kein 'ready' -- der
    // naechste Takt startet stattdessen den BAU-Lauf.
    it('mergt den gruenen Entwurfs-PR ohne "check" nicht, sondern startet den Bau-Lauf (#880 AC4)', () => {
      const { gh, calls } = ghDouble(prRoutes(70, ['in-progress'], greenChecks));
      const result = roundPlan(ctx(gh, gitDouble(lsRemote)), opts);
      expect(called(calls, 'pr', 'ready')).toBe(false);
      expect(called(calls, 'pr', 'merge')).toBe(false);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).role).toBe('build');
    });

    // Rote CI schlaegt das Tor: ueber einen kaputten Stand ist nicht zu
    // urteilen, und der nur lesende Pruefer koennte daran nichts aendern.
    it('nimmt bei roter CI das Label zurueck und laesst erst fixen', () => {
      const { gh, calls } = ghDouble(prRoutes(70, ['in-progress', 'check'], redChecks));
      const result = roundPlan(ctx(gh, gitDouble(lsRemote)), opts);
      expect(called(calls, 'edit', '70', '--remove-label', 'check')).toBe(true);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).role).toBe('build');
      expect((result as RoundRun).prompt).toContain('Was rot ist');
    });

    // Ohne Kriterien waere "alle erfuellt" trivial wahr -- der einzige Lauf,
    // der mergen darf, wuerde ausgerechnet dort ohne Massstab durchwinken.
    it('prueft nicht ohne Kriterien, sondern gibt das Label zurueck', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(70, ['in-progress', 'check'], '2024-01-01T00:00:00Z', noAk)),
        noOpenPrs,
        labelsAre('in-progress', 'check'),
      ]);
      const result = roundPlan(ctx(gh, gitDouble(lsRemote)), opts);
      expect(result.kind).toBe('done');
      expect(called(calls, 'edit', '70', '--remove-label', 'check')).toBe(true);
      expect(result.status?.title).toContain('keine AK');
    });

    it('gibt das Label zurueck, wenn es zu pruefen nichts gibt', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(70, ['in-progress', 'check'])),
        noOpenPrs,
        labelsAre('in-progress', 'check'),
      ]);
      const result = roundPlan(ctx(gh, gitDouble()), opts);
      expect(result.kind).toBe('done');
      expect(called(calls, 'edit', '70', '--remove-label', 'check')).toBe(true);
    });
  });

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

  // #588: der Snapshot rendert keine Fund-Tickets mehr in den Auftragstext.
  // Ein Ticket mit einer 'Fund:'-Zeile im Body ist ab jetzt ein ganz normales
  // Ticket -- die Zeile ist Text, kein Schluessel.
  it('rendert keine Fund-Ticket-Liste in den Bau-Prompt', () => {
    const { gh } = ghDouble([
      openIssues(
        issueJson(77, ['ready']),
        issueJson(349, [], '2026-07-29T09:36:00Z', 'Fund: tests/aktivitaeten.spec.ts:608'),
      ),
      noOpenPrs,
    ]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.kind).toBe('run');
    expect(run.prompt).not.toContain('Bekannte Fund-Tickets');
    expect(run.prompt).not.toContain('tests/aktivitaeten.spec.ts:608');
  });

  it('traegt stattdessen das Verbot samt Ersatzweg in den Bau-Prompt', () => {
    const { gh } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.prompt).toContain('## Funde: kein neues Ticket');
    expect(run.prompt).toContain('## Funde nebenbei');
  });

  it('gibt der Planer-Rolle Opus und eine nur lesende Allowlist (ADR-0005)', () => {
    const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
    const run = roundPlan(ctx(gh), opts) as RoundRun;
    expect(run.role).toBe('plan');
    expect(run.model).toBe('opus');
    // Kein `Edit` und kein pauschales `Bash` -- das ist seit ADR-0025 der
    // Kern der Lese-Zusage. `Write` steht bewusst drin (Artifact braucht eine
    // Datei) und ist folgenlos: der cwd ist ein Wegwerf-Worktree, und Claude
    // Code sperrt Schreibzugriffe ohnehin auf den Arbeitsbaum ein.
    expect(run.tools).not.toContain('Edit');
    expect(run.tools.split(',')).not.toContain('Bash');
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

  // --- Denk-Rollen-Tagesdeckel (#492, Nachtrag zu ADR-0005) -----------------
  describe('Denk-Rollen-Tagesdeckel (#492)', () => {
    it('laesst die Planer-Rolle unter dem Deckel unangetastet und reserviert einen Slot', () => {
      const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.kind).toBe('run');
      expect(state.read('thinking-cap-20260726')?.trim()).toBe('1');
    });

    it('stoppt die Planer-Rolle, sobald der flottenweite Tagesdeckel erreicht ist', () => {
      state.write('thinking-cap-20260726', '20');
      const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Denk-Rollen');
      // Der Zaehler bleibt bei 20, kein weiterer Verbrauch fuer den geblockten Lauf.
      expect(state.read('thinking-cap-20260726')?.trim()).toBe('20');
    });

    it('stoppt auch die Recherche-Rolle am selben, gemeinsamen Zaehler', () => {
      state.write('thinking-cap-20260726', '20');
      const { gh } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Denk-Rollen');
    });

    it('zaehlt Planer- und Recherche-Laeufe ticketuebergreifend im selben Zaehler', () => {
      const { gh: ghPlan } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      roundPlan(ctx(ghPlan), opts);
      const { gh: ghResearch } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
      roundPlan(ctx(ghResearch), opts);
      expect(state.read('thinking-cap-20260726')?.trim()).toBe('2');
    });

    it('laesst Bau-Laeufe vom Deckel unberuehrt, auch wenn er erschoepft ist', () => {
      state.write('thinking-cap-20260726', '20');
      const { gh } = ghDouble([openIssues(issueJson(82, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.kind).toBe('run');
      expect(run.role).toBe('build');
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

  // #767 (ADR-0024): beide Denk-Rollen duerfen ein Artifact veroeffentlichen,
  // die Bau-Rolle nicht (Scope-Creep, AK4).
  it('gibt beiden Denk-Rollen Artifact, der Bau-Rolle nicht', () => {
    const { gh: ghPlan } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
    const plan = roundPlan(ctx(ghPlan), opts) as RoundRun;
    const { gh: ghResearch } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
    const research = roundPlan(ctx(ghResearch), opts) as RoundRun;
    const { gh: ghBuild } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
    const build = roundPlan(ctx(ghBuild), opts) as RoundRun;
    expect(plan.tools).toContain('Artifact');
    expect(research.tools).toContain('Artifact');
    expect(build.tools).not.toContain('Artifact');
  });

  // O3 (#325): harte Werkzeug-Verweigerung zusaetzlich zur Allowlist, nur
  // fuer die Denk-Rollen.
  describe('denyTools + beforeDirty (#325)', () => {
    it('liefert denyTools=Edit und die Baseline fuer die Planer-Rolle', () => {
      const git = gitDouble({ 'status --porcelain': ' M docs/WORKFLOW.md' });
      const { gh } = ghDouble([openIssues(issueJson(80, ['plan'])), noOpenPrs]);
      const run = roundPlan(ctx(gh, git), opts) as RoundRun;
      expect(run.denyTools).toBe('Edit');
      expect(run.beforeDirty).toBe(' M docs/WORKFLOW.md');
    });

    it('liefert denyTools=Edit auch fuer die Recherche-Rolle', () => {
      const { gh } = ghDouble([openIssues(issueJson(81, ['research'])), noOpenPrs]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.denyTools).toBe('Edit');
    });

    // ADR-0025: `Write` ist bei den Denk-Rollen nicht mehr verboten, weil
    // `Artifact` nur einen file_path auf eine schon geschriebene Datei nimmt.
    // Ohne beides zusammen laeuft der Lauf in einen Freigabe-Dialog, den
    // unbeaufsichtigt niemand bestaetigt (#752).
    it.each([
      ['plan', 80],
      ['research', 81],
    ])('gibt der %s-Rolle Artifact UND Write, verbietet aber weiter Edit', (label, nr) => {
      const { gh } = ghDouble([openIssues(issueJson(nr, [label])), noOpenPrs]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.tools).toContain('Artifact');
      expect(run.tools).toContain('Write');
      expect(run.denyTools).toBe('Edit');
      expect(run.denyTools).not.toContain('Write');
    });

    // Gegenprobe: Edit darf nie in die Allowlist der Denk-Rollen rutschen --
    // neu anlegen ja, Bestehendes aendern nein.
    it.each([
      ['plan', 80],
      ['research', 81],
    ])('gibt der %s-Rolle kein Edit', (label, nr) => {
      const { gh } = ghDouble([openIssues(issueJson(nr, [label])), noOpenPrs]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.tools).not.toContain('Edit');
    });

    it('laesst denyTools und beforeDirty bei der Bau-Rolle leer', () => {
      const git = gitDouble({ 'status --porcelain': ' M docs/WORKFLOW.md' });
      const { gh } = ghDouble([openIssues(issueJson(77, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const run = roundPlan(ctx(gh, git), opts) as RoundRun;
      expect(run.denyTools).toBe('');
      expect(run.beforeDirty).toBe('');
    });
  });

  // #387 AC2: ein Denk-Lauf, der wegen in-progress ueber den running-Zweig
  // fortgesetzt wird, muss Denk-Lauf bleiben -- nicht hart als Bau-Lauf
  // zurueckkommen (READONLY_TOOLS/planPrompt()/Opus wuerden sonst
  // faelschlich uebersprungen und ein halbfertiger Plan gebaut).
  describe('Resume-Rolle eines fortgesetzten Denk-Laufs (#387 AC2)', () => {
    it('ein Ticket mit in-progress + plan wird als Planer-Lauf fortgesetzt, nicht als Bau-Lauf', () => {
      const { gh } = ghDouble([openIssues(issueJson(80, ['in-progress', 'plan'])), noOpenPrs, labelsAre('in-progress', 'plan')]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('plan');
      expect(run.model).toBe('opus');
      expect(run.tools).toBe(`${READONLY_TOOLS},Artifact,Write`);
      expect(run.denyTools).toBe('Edit');
      expect(run.prompt).toContain('als **Planer**');
      expect(run.beforeTip).toBe('');
    });

    it('ein Ticket mit in-progress + research wird als Recherche-Lauf fortgesetzt', () => {
      const { gh } = ghDouble([openIssues(issueJson(81, ['in-progress', 'research'])), noOpenPrs, labelsAre('in-progress', 'research')]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('research');
      expect(run.model).toBe('opus');
      expect(run.tools).toContain('WebSearch');
      expect(run.tools).toContain('Artifact');
      expect(run.denyTools).toBe('Edit');
    });

    it('ein Ticket mit nur in-progress (Bau) bleibt unveraendert Bau-Rolle', () => {
      const { gh } = ghDouble([openIssues(issueJson(82, ['in-progress'])), noOpenPrs, labelsAre('in-progress')]);
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('build');
      expect(run.tools).toContain('Write');
      expect(run.tools).not.toContain('Artifact');
      expect(run.denyTools).toBe('');
    });
  });

  // #742: Bau-Laeufe resumen nie -- ein 45-Minuten-Transkript wird auf jeder
  // Anfrage erneut abgerechnet, das uebersteigt fast immer die einmalige
  // Neu-Lektuere von Git + Fortschrittskommentar. Denk-Rollen bleiben
  // unveraendert, weil sie ihren Kontext bewusst in der Session tragen.
  describe('Kein Resume fuers Bauen (#742)', () => {
    it('haengt fuer die Bau-Rolle nie --resume an, selbst mit gespeicherter Session-ID', () => {
      const { gh } = ghDouble([openIssues(issueJson(82, ['in-progress'])), noOpenPrs, labelsAre('in-progress')]);
      state.write('session-82', 'sid-build-alt');
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('build');
      expect(run.resume).toBe('');
    });

    it('resumt die Planer-Rolle weiterhin mit der gespeicherten Session-ID (Rollen-Asymmetrie)', () => {
      const { gh } = ghDouble([openIssues(issueJson(80, ['in-progress', 'plan'])), noOpenPrs, labelsAre('in-progress', 'plan')]);
      state.write('session-think-80', 'sid-plan-alt');
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('plan');
      expect(run.resume).toBe('sid-plan-alt');
    });

    it('resumt die Recherche-Rolle weiterhin mit der gespeicherten Session-ID (Rollen-Asymmetrie)', () => {
      const { gh } = ghDouble([openIssues(issueJson(81, ['in-progress', 'research'])), noOpenPrs, labelsAre('in-progress', 'research')]);
      state.write('session-think-81', 'sid-research-alt');
      const run = roundPlan(ctx(gh), opts) as RoundRun;
      expect(run.role).toBe('research');
      expect(run.resume).toBe('sid-research-alt');
    });
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
  // --- Queue-Bericht + blocked-by (#265, seit #725 ohne Queue-Issue) --------
  // Der Rang ('next') hat keinen eigenen Bericht -- die Auswahl selbst zeigt
  // ihn (Status-Titel nennt das gewaehlte Ticket). Was hier bleibt: Ketten aus
  // 'Nach:'-Zeilen im Ticket-Body und Zirkel. 'blocked-by' setzt und entfernt
  // der Runner selbst.
  describe('Queue-Bericht (#265/#725)', () => {
    it('AC4: ein blockiertes Ticket bekommt blocked-by und wird nicht gebaut', () => {
      const { gh, calls } = ghDouble([
        openIssues(issueJson(266, ['ready'], '2024-01-01T00:00:00Z', `Nach: #227\n\n${AK_BODY}`), issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z')),
        noOpenPrs,
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '266', '--add-label', 'blocked-by')).toBe(true);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Wartet auf Vorarbeit: #266 (nach #227)');
    });

    it('AC5: faellt die Voraussetzung weg, nimmt der Runner blocked-by von selbst ab', () => {
      // #227 ist geschlossen -> nicht mehr im Snapshot.
      const { gh, calls } = ghDouble([
        openIssues(issueJson(266, ['ready', 'blocked-by'], '2024-01-01T00:00:00Z', `Nach: #227\n\n${AK_BODY}`)),
        noOpenPrs,
        labelsAre('ready'),
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '266', '--remove-label', 'blocked-by')).toBe(true);
      expect(result.kind).toBe('run');
      expect((result as RoundRun).issue).toBe(266);
    });

    it('setzt blocked-by nicht doppelt, wenn es schon haengt', () => {
      const { gh, calls } = ghDouble([
        openIssues(
          issueJson(266, ['ready', 'blocked-by'], '2024-01-01T00:00:00Z', `Nach: #227\n\n${AK_BODY}`),
          issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z'),
        ),
        noOpenPrs,
      ]);
      roundPlan(ctx(gh), opts);
      expect(called(calls, 'edit', '266', '--add-label', 'blocked-by')).toBe(false);
    });

    it('AC6: ein Zirkel wird gemeldet und keins der Tickets gebaut', () => {
      const { gh } = ghDouble([
        openIssues(
          issueJson(1, ['ready'], '2024-01-01T00:00:00Z', `Nach: #2\n\n${AK_BODY}`),
          issueJson(2, ['ready'], '2024-02-01T00:00:00Z', `Nach: #1\n\n${AK_BODY}`),
        ),
        noOpenPrs,
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.text).toContain('Zirkel in der Queue:** #1, #2');
    });

    it('ohne Nach:-Ketten bleibt der Statustext unveraendert', () => {
      const { gh } = ghDouble([openIssues(issueJson(300, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.text).not.toContain('Wartet auf Vorarbeit');
      expect(result.status?.text).not.toContain('Zirkel');
    });
  });

  // #357, Owner-Entscheidung "C" (29.07.26): untriagierte Fund-Tickets
  // sichtbar machen. Gebaut wird davon nichts -- reine Anzeige im ohnehin
  // geschriebenen Queue-Bericht.
  describe('Untriagiert-Bericht (#357)', () => {
    const statusOpts = { ...opts, statusIssue: 1 };

    it('ein labelloses Ticket erscheint als untriagiert', () => {
      const { gh } = ghDouble([openIssues(issueJson(349, [])), noOpenPrs]);
      const result = roundPlan(ctx(gh), statusOpts);
      expect(result.status?.text).toContain('**Untriagiert** (kein Steuerlabel): #349');
    });

    it('erscheint auch ohne offene Nach:-Ketten -- anders als "Wartet auf Vorarbeit"', () => {
      const { gh } = ghDouble([openIssues(issueJson(349, [])), noOpenPrs]);
      const result = roundPlan(ctx(gh), statusOpts);
      expect(result.status?.text).toContain('Untriagiert');
    });

    it('das Status-Issue selbst erscheint nie, obwohl offen und labellos', () => {
      const { gh } = ghDouble([openIssues(issueJson(1, []), issueJson(349, [])), noOpenPrs]);
      const result = roundPlan(ctx(gh), statusOpts);
      // Nur die Ticketliste selbst pruefen, nicht die ganze Zeile.
      const match = (result.status?.text ?? '').match(/kein Steuerlabel\): ([^—]+)/);
      expect(match?.[1].trim()).toBe('#349');
    });

    it('ein ready-Ticket zaehlt nicht als untriagiert', () => {
      const { gh } = ghDouble([openIssues(issueJson(300, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const result = roundPlan(ctx(gh), statusOpts);
      expect(result.status?.text).not.toContain('Untriagiert');
    });

    it('loest keinen Schreibzugriff aus -- reine Anzeige', () => {
      const { gh, calls } = ghDouble([openIssues(issueJson(349, [])), noOpenPrs]);
      roundPlan(ctx(gh), statusOpts);
      expect(calls.some((args) => args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'comment') && args[2] === '349')).toBe(
        false,
      );
    });
  });

  // #296/#725: "Queue" gegen "Offen" gab es nur, solange #92 existierte --
  // mit dem Queue-Issue ist die Unterscheidung weg, der Status sagt jetzt in
  // jedem Fall "Offen: …".
  describe('Wortlaut im Status: immer "Offen" (#296/#725)', () => {
    // queuePending() holt sich ueber queueSnapshot() einen EIGENEN Schnappschuss
    // (--limit 50, nicht 100 wie der Runden-Schnappschuss) -- ohne diese
    // zusaetzliche Route bleibt die Antwort leer und `pending` faelschlich ''.
    const openIssues50 = (...issues: ReturnType<typeof issueJson>[]) => ({
      match: (a: string[]) => a[0] === 'issue' && a[1] === 'list' && a.includes('--limit') && a.includes('50'),
      reply: JSON.stringify(issues),
    });

    it('hands-off-Ticket: "Offen", nie "Queue"', () => {
      const { gh } = ghDouble([
        openIssues(issueJson(204, ['plan', 'hands-off'])),
        openIssues50(issueJson(204, ['plan', 'hands-off'])),
        noOpenPrs,
      ]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.title).toBe('wartet auf nächsten Lauf · Offen: #204');
      expect(result.status?.title).not.toContain('Queue');
      expect(result.status?.text).toContain('Offen ist noch Arbeit (#204)');
    });

    it('ein blockiertes Ticket: ebenfalls "Offen", nie "Queue"', () => {
      const issues = [issueJson(266, ['ready'], '2024-01-01T00:00:00Z', `Nach: #227\n\n${AK_BODY}`), issueJson(227, ['hands-off'], '2024-02-01T00:00:00Z')];
      const { gh } = ghDouble([openIssues(...issues), openIssues50(...issues), noOpenPrs]);
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('done');
      expect(result.status?.title).toBe('wartet auf nächsten Lauf · Offen: #266');
      expect(result.status?.title).not.toContain('Queue');
      expect(result.status?.text).toContain('Offen ist noch Arbeit (#266)');
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
        // #880: bereits freigegeben (isDraft:false) -- ein wartendes Ticket, das
        // ein Mensch schon aus dem Entwurf gehoben hat, darf die Wache mergen.
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus,isDraft'),
        reply: JSON.stringify({ headRefName: `feat/${issue}-x`, mergeStateStatus: 'CLEAN', isDraft: false }),
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
          match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus,isDraft'),
          reply: JSON.stringify({ headRefName: 'feat/92-a', mergeStateStatus: 'CLEAN', isDraft: false }),
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

  // #483 (F11): der Claim fuer ein fortgesetztes Ticket muss VOR jedem
  // Seiteneffekt der CI-Wache stehen -- sonst faehrt ein Slot ohne Claim
  // (Sweep/Absturz/Handlabeln) trotzdem `pr ready`/Merge/Nachziehen.
  describe('CI-Wache laeuft erst nach claimTake (#483, F11)', () => {
    const withPr = (issue: number, labels: string[], checks: string) => [
      openIssues(issueJson(issue, labels)),
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'list',
        reply: JSON.stringify([{ number: 5, title: 'feat: x', headRefName: `feat/${issue}-x` }]),
      },
      { match: (a: string[]) => a.includes('checks'), reply: checks },
      labelsAre(...labels),
    ];

    const pending = JSON.stringify([{ bucket: 'pending', name: 'e2e' }]);
    const green = JSON.stringify([{ bucket: 'pass', name: 'quality' }, { bucket: 'pass', name: 'e2e' }]);
    const failing = JSON.stringify([{ bucket: 'fail', name: 'e2e' }]);

    // #880: `isDraft: false` -- ein bereits freigegebener PR (Alt-PR/von Hand),
    // den die Wache noch mergen darf. Ein Entwurf landete in 'gated'.
    const withMergeState = (issue: number, extra: { match: (a: string[]) => boolean; reply: string }[] = []) => [
      ...withPr(issue, ['in-progress'], green),
      {
        match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('headRefName,mergeStateStatus,isDraft'),
        reply: JSON.stringify({ headRefName: `feat/${issue}-x`, mergeStateStatus: 'CLEAN', isDraft: false }),
      },
      { match: (a: string[]) => a[0] === 'pr' && a[1] === 'view' && a.includes('.title'), reply: 'feat: x' },
      ...extra,
    ];

    // Modelliert die enge Rennluecke, die F11 schliesst: `claimedElsewhere()`
    // liest `list()` VOR dem eigentlichen `claimTake` -- ein Claim, der genau
    // dazwischen von einem anderen Slot landet, ist fuer `list()` noch
    // unsichtbar (Snapshot ist schon aeltere Momentaufnahme), laesst das
    // Ticket also den vorgelagerten Filter passieren, faellt dann aber beim
    // atomaren `claimTake` durch. Der echte fs-Adapter kann dieses Fenster in
    // einem synchronen Test nicht abbilden -- deshalb ein Double.
    function raceClaims(owner: string): ClaimAdapter {
      return {
        claimAtomic: () => false,
        readSlot: () => owner,
        ageMs: () => null,
        list: () => [],
        release: () => {},
        sweepTmp: () => {},
      };
    }

    // AK1/AK2: ein anderer Slot gewinnt das atomare `claimTake` GENAU in der
    // Luecke -- Slot '1' verliert den Claim, BEVOR `prForIssue`/die Wache
    // ueberhaupt laeuft. Kein Agentenlauf, kein einziger gh-Schreibzugriff.
    it('AK1/AK2: Claim im Rennen verloren -- Runde endet ohne gh-Schreibzugriff, kein Wache-Seiteneffekt', () => {
      const { gh, calls } = ghDouble(withPr(77, ['in-progress'], pending));
      const result = roundPlan({ ...ctx(gh), claims: raceClaims('2'), slotId: '1' }, { ...opts, isLead: false });
      expect(result.kind).toBe('done');
      expect(result.status?.title).toBe('#77 an anderen Slot verloren');
      expect(called(calls, 'pr', 'ready')).toBe(false);
      expect(called(calls, 'pr', 'checks')).toBe(false);
      expect(called(calls, 'issue', 'comment')).toBe(false);
      expect(called(calls, 'edit')).toBe(false);
    });

    // AK1/AK3 pending: der Claim steht schon, BEVOR die Wache ueberhaupt
    // `prForIssue` aufruft.
    it('AK1/AK3: pendender PR -- Claim ist gehalten, bevor die Wache entscheidet', () => {
      const { gh } = ghDouble(withPr(77, ['in-progress'], pending));
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.text).toContain('CI läuft für #77');
      expect(claims.readSlot(77)).toBe('1');
    });

    // AK3 merged: gruener, bereits freigegebener (nicht-Entwurfs-)PR -- die
    // Wache merged UND behaelt den Claim (er verfaellt am Label 'in-progress',
    // nicht am Ausgang des Bau-Laufs). #880: sie ruft dabei NIE selbst
    // `gh pr ready` -- das gehoert dem Pruef-Lauf.
    it('AK3 (#880): kein Entwurf -- Merge laeuft ohne selbst `gh pr ready`, Claim bleibt gehalten', () => {
      const { gh, calls } = ghDouble(withMergeState(77));
      const result = roundPlan(ctx(gh), opts);
      expect(result.status?.text).toContain('bereits freigegeben');
      expect(called(calls, 'pr', 'ready')).toBe(false);
      expect(called(calls, 'pr', 'merge')).toBe(true);
      expect(claims.readSlot(77)).toBe('1');
    });

    // AK3 build-fix: rote Checks -- ein Bau-Lauf mit CI-Fix-Auftrag startet,
    // der Claim bleibt gehalten (derselbe Slot baut ja weiter an #77).
    it('AK3: rote Checks -- CI-Fix-Lauf startet, Claim bleibt gehalten', () => {
      const { gh } = ghDouble(withPr(77, ['in-progress'], failing));
      const result = roundPlan(ctx(gh), opts);
      expect(result.kind).toBe('run');
      if (result.kind === 'run') {
        expect(result.role).toBe('build');
      }
      expect(claims.readSlot(77)).toBe('1');
    });

    // F11-Kern: zwei Slots im selben Takt, KEIN Vorab-Claim -- Slot '1' claimt
    // und faehrt die Wache; Slot '2' sieht #77 danach ueber `claimedElsewhere()`
    // als fremd beansprucht und betritt die Wache gar nicht erst (weder
    // `prForIssue` noch ein Wache-Seiteneffekt) -- der Claim bleibt bei Slot 1.
    it('F11: zwei Slots ohne Vorab-Claim -- nur der Gewinner faehrt die Wache', () => {
      const { gh: gh1, calls: calls1 } = ghDouble(withPr(77, ['in-progress'], pending));
      const result1 = roundPlan(ctx(gh1), opts);
      expect(result1.status?.text).toContain('CI läuft für #77');
      expect(called(calls1, 'pr', 'checks')).toBe(true);

      const { gh: gh2, calls: calls2 } = ghDouble(withPr(77, ['in-progress'], pending));
      const result2 = roundPlan({ ...ctx(gh2), slotId: '2' }, { ...opts, isLead: false });
      expect(result2.kind).toBe('done');
      expect(called(calls2, 'pr', 'checks')).toBe(false);
      expect(called(calls2, 'pr', 'ready')).toBe(false);
      expect(claims.readSlot(77)).toBe('1');
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

  // #484: tier-/opus-build-/opus-cap-msg- gehoeren in den sharedState, nicht
  // ins slot-lokale state -- sonst zaehlt der Opus-Tagesdeckel (und die
  // Eskalationsstufe) pro Slot statt flottenweit.
  describe('Ticket-Zaehler leben im sharedState, nicht im slot-lokalen state (#484)', () => {
    let sharedDir2: string;
    let sharedState2: StateAdapter;

    beforeEach(() => {
      sharedDir2 = mkdtempSync(join(tmpdir(), 'round-shared-'));
      sharedState2 = createStateAdapter(sharedDir2);
    });
    afterEach(() => {
      rmSync(sharedDir2, { recursive: true, force: true });
    });

    it('AC1/AC3: der Opus-Tagesdeckel liest/schreibt sharedState, das slot-lokale state bleibt leer', () => {
      sharedState2.write('opus-build-20260726-77', '2');
      const { gh, calls } = ghDouble([
        openIssues(issueJson(77, ['ready', 'model:opus'])),
        noOpenPrs,
        labelsAre('ready', 'model:opus'),
      ]);
      const result = roundPlan(
        { gh, git: gitDouble(), state, sharedState: sharedState2, claims, slotId: '1', clock: CLOCK },
        opts,
      );
      expect(result.status?.text).toContain('Opus-Tagesbudget');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
      expect(state.exists('opus-build-20260726-77')).toBe(false);
    });

    it('AC1: eine eskalierte Modellstufe (tier-<nr>) kommt aus sharedState', () => {
      sharedState2.write('tier-96', 'opus');
      const { gh } = ghDouble([openIssues(issueJson(96, ['ready'])), noOpenPrs, labelsAre('ready')]);
      const run = roundPlan(
        { gh, git: gitDouble(), state, sharedState: sharedState2, claims, slotId: '1', clock: CLOCK },
        opts,
      ) as RoundRun;
      expect(run.model).toBe('opus');
      expect(state.exists('tier-96')).toBe(false);
    });

    it('AC2: ein anderer Slot (eigenes state-Verzeichnis) sieht denselben erschoepften Deckel ueber das gemeinsame sharedState', () => {
      sharedState2.write('opus-build-20260726-77', '2');
      const stateSlot2Dir = mkdtempSync(join(tmpdir(), 'round-slot2-'));
      const stateSlot2 = createStateAdapter(stateSlot2Dir);
      try {
        const { gh, calls } = ghDouble([
          openIssues(issueJson(77, ['ready', 'model:opus'])),
          noOpenPrs,
          labelsAre('ready', 'model:opus'),
        ]);
        const result = roundPlan(
          { gh, git: gitDouble(), state: stateSlot2, sharedState: sharedState2, claims, slotId: '2', clock: CLOCK },
          opts,
        );
        expect(result.status?.text).toContain('Opus-Tagesbudget');
        expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
      } finally {
        rmSync(stateSlot2Dir, { recursive: true, force: true });
      }
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
    branch: '',
    kind: 'run',
    status: { title: '', emoji: '', text: '' },
    issue: 77,
    role: 'build',
    model: 'sonnet',
    tools: '',
    resume: '',
    labels: 'ready ',
    beforeTip: 'abc',
    runStart: '',
    didWork: false,
    lastIssue: '',
    prompt: '',
    beforeDirty: '',
    denyTools: '',
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

  // #356 (A): Bau- und Denk-Rollen teilen sich die Session-Datei nicht mehr --
  // ein Bau-Lauf las sonst die Session eines vorangegangenen Plan-Laufs und
  // reichte sie per --resume in einem cwd durch, das die CLI nie sah (#353).
  it('schreibt die Session einer Denk-Rolle unter session-think-<nr>, nicht session-<nr>', () => {
    const { gh } = ghDouble();
    roundEval(ctx(gh), { ...plan, role: 'plan' }, ok, '');
    expect(state.read('session-think-77')).toBe('sid-1');
    expect(state.read('session-77')).toBeNull();
  });

  it('schreibt die Session einer Bau-Rolle weiterhin unter session-<nr>', () => {
    const { gh } = ghDouble();
    roundEval(ctx(gh), plan, ok, '');
    expect(state.read('session-77')).toBe('sid-1');
    expect(state.read('session-think-77')).toBeNull();
  });

  // #740: Token-Verbrauch je Lauf als Logzeile, damit Sparmassnahmen mess-
  // statt schaetzbar werden. Muster wie cli.test.ts: Spy inline je Test, nicht
  // ueber eine vorab typisierte Variable -- 'process.stderr.write' ist
  // ueberladen, eine explizit typisierte Spy-Instanz passt dann nicht mehr
  // (tsc-Fehler). Deshalb nimmt der Helfer nur die rohen 'mock.calls' entgegen.
  function usageLine(calls: unknown[][]): Record<string, unknown> {
    const line = calls.map((c) => String(c[0])).find((l) => l.startsWith('runner-usage '));
    expect(line).toBeDefined();
    return JSON.parse(line!.slice('runner-usage '.length)) as Record<string, unknown>;
  }

  describe('Verbrauchs-Logzeile (#740)', () => {
    // AK1: usage.* + num_turns landen aus dem verschachtelten 'usage'-Objekt
    // in der Logzeile.
    it('schreibt usage.* und num_turns aus dem Ergebnis-JSON nach STDERR', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { gh } = ghDouble();
      roundEval(
        ctx(gh),
        plan,
        {
          rc: 0,
          out: JSON.stringify({
            session_id: 'sid-1',
            result: 'ok',
            num_turns: 12,
            usage: {
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 500,
              input_tokens: 30,
              output_tokens: 250,
            },
          }),
          timedOut: false,
          maxRuntime: 2700,
        },
        '',
      );
      expect(usageLine(stderr.mock.calls)).toMatchObject({
        cache_read_input_tokens: '4000',
        cache_creation_input_tokens: '500',
        input_tokens: '30',
        output_tokens: '250',
        num_turns: '12',
      });
      stderr.mockRestore();
    });

    // AK2: Rolle, Modell und Resume-Modus stehen mit in der Zeile, damit
    // Bau- gegen Denklaeufe und Resume- gegen Frischlaeufe trennbar sind.
    it('haengt Rolle, Modell und Resume-Modus an', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { gh } = ghDouble();
      roundEval(ctx(gh), { ...plan, role: 'plan', model: 'opus', resume: 'sid-old' }, ok, '');
      expect(usageLine(stderr.mock.calls)).toMatchObject({ role: 'plan', model: 'opus', resume: 'resume' });
      stderr.mockRestore();
    });

    it('markiert einen frischen Lauf (kein --resume) als "fresh"', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { gh } = ghDouble();
      roundEval(ctx(gh), { ...plan, resume: '' }, ok, '');
      expect(usageLine(stderr.mock.calls)).toMatchObject({ resume: 'fresh' });
      stderr.mockRestore();
    });

    // AK3: Notbremsen-Kill -- $OUT ist kein valides JSON, parseField liefert
    // ''. Der Lauf bleibt trotzdem erfolgreich (kein Abbruch), die Felder
    // fehlen still.
    it('bricht bei einem Ergebnis-JSON ohne usage-Objekt nicht ab -- Felder fehlen still', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { gh } = ghDouble();
      expect(() =>
        roundEval(ctx(gh), plan, { rc: 1, out: 'kaputt (Notbremsen-Kill)', timedOut: true, maxRuntime: 2700 }, ''),
      ).not.toThrow();
      expect(usageLine(stderr.mock.calls)).toMatchObject({
        cache_read_input_tokens: '',
        cache_creation_input_tokens: '',
        input_tokens: '',
        output_tokens: '',
        num_turns: '',
      });
      stderr.mockRestore();
    });
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

  // #387 AC4: der Prompt weist Claude an, beim Flip auch 'in-progress' zu
  // entfernen -- dieser Backstop im Runner setzt es deterministisch durch,
  // falls ein Lauf das vergisst oder abbricht, nachdem er schon geflippt hat.
  describe('in-progress-Backstop fuer Denk-Rollen (#387 AC4)', () => {
    it('entfernt in-progress, wenn der Planer-Lauf sauber auf ready geflippt hat (plan-Label weg)', () => {
      const { gh, calls } = ghDouble([{ match: (a) => a.includes('labels'), reply: 'ready' }]);
      roundEval(ctx(gh), { ...plan, role: 'plan' }, ok, '');
      expect(called(calls, 'edit', '77', '--remove-label', 'in-progress')).toBe(true);
    });

    it('entfernt in-progress, wenn der Recherche-Lauf auf needs-answer geflippt hat (research-Label weg)', () => {
      const { gh, calls } = ghDouble([{ match: (a) => a.includes('labels'), reply: 'needs-answer' }]);
      const result = roundEval(ctx(gh), { ...plan, role: 'research' }, ok, '');
      expect(called(calls, 'edit', '77', '--remove-label', 'in-progress')).toBe(true);
      // needs-answer greift danach weiterhin -- die Chain stoppt gelb.
      expect(result.status?.emoji).toBe('🟡');
    });

    it('laesst in-progress stehen, wenn der Planer nur eine Frage gestellt hat (plan-Label bleibt)', () => {
      const { gh, calls } = ghDouble([{ match: (a) => a.includes('labels'), reply: 'plan\nneeds-answer' }]);
      roundEval(ctx(gh), { ...plan, role: 'plan' }, ok, '');
      expect(called(calls, 'edit', '77', '--remove-label', 'in-progress')).toBe(false);
    });

    it('fasst in-progress bei der Bau-Rolle nicht an', () => {
      const { gh, calls } = ghDouble([{ match: (a) => a.includes('labels'), reply: 'ready' }]);
      roundEval(ctx(gh), plan, ok, '');
      expect(called(calls, 'edit', '77', '--remove-label', 'in-progress')).toBe(false);
    });
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

  // #741: eine offene Frage (needs-answer) ist kein Eskalations-Fehlversuch.
  // buildEscalationEval() bekommt den Endgrund jetzt VOR seinem Aufruf
  // (labelsOf() ist dafuer vorgezogen worden) und wertet ihn intern aus.
  describe('needs-answer zaehlt nicht als Eskalations-Fehlversuch (#741)', () => {
    it('AC1: laesst failcount- unangetastet, wenn der Lauf ueber needs-answer endet', () => {
      const { gh } = ghDouble([labelsAre('ready', 'needs-answer')]);
      roundEval(ctx(gh), plan, ok, '');
      expect(sharedState.exists('failcount-77')).toBe(false);
    });

    it('AC2: drei aufeinanderfolgende Rueckfragen eskalieren die Modellstufe nicht', () => {
      const { gh } = ghDouble([labelsAre('ready', 'needs-answer')]);
      roundEval(ctx(gh), plan, ok, '');
      roundEval(ctx(gh), plan, ok, '');
      roundEval(ctx(gh), plan, ok, '');
      expect(sharedState.exists('tier-77')).toBe(false);
    });

    it('AC3: loest den F26-Waechter (Auffaelligkeit) nicht aus, selbst mit einem frischen Fortschrittskommentar', () => {
      const { gh, calls } = ghDouble([
        labelsAre('ready', 'needs-answer'),
        {
          match: (a) => a[0] === 'issue' && a[1] === 'view' && a.includes('comments'),
          reply: JSON.stringify({
            comments: [
              {
                body: '## 🤖 Fortschritt (automatisch aktualisiert)\n\nirgendwas',
                createdAt: '2026-07-26T09:25:00Z',
              },
            ],
          }),
        },
      ]);
      roundEval(ctx(gh), { ...plan, runStart: '2026-07-26T09:20:00Z' }, ok, '');
      expect(calls.some((args) => args.join(' ').includes('Auffälligkeit'))).toBe(false);
    });

    it('AC4: ein inhaltlicher Stillstand ohne needs-answer zaehlt weiterhin als Fehlversuch', () => {
      const { gh } = ghDouble([labelsAre('ready')]);
      roundEval(ctx(gh), plan, ok, '');
      expect(sharedState.read('failcount-77')).toBe('1\n');
    });
  });

  // #484: failcount-/blocker-sig- (buildEscalationEval) gehoeren neben
  // limit-until in den sharedState -- sonst zaehlt die Eskalation pro Slot
  // neu, sobald ein Ticket den Slot wechselt.
  describe('Ticket-Zaehler leben im sharedState, nicht im slot-lokalen state (#484)', () => {
    it('AC1: ein inhaltlicher Fehlschlag schreibt failcount- ins sharedState, nicht ins state', () => {
      const { gh } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        { rc: 1, out: '{"result":"echter Fehlschlag"}', timedOut: false, maxRuntime: 2700 },
        '',
      );
      expect(result.chain).toBe('stop');
      expect(sharedState.read('failcount-77')).toBe('1\n');
      expect(state.exists('failcount-77')).toBe(false);
    });

    it('AC1: eine neue Blocker-Signatur schreibt blocker-sig- ins sharedState, nicht ins state', () => {
      const { gh } = ghDouble([
        {
          match: (a) => a.includes('comments'),
          reply:
            '## 🤖 Fortschritt (automatisch aktualisiert)\n\n_Lauf-Ende 16.07. 10:00: gate-rot, unfertig — nächster Lauf macht weiter._',
        },
      ]);
      roundEval(ctx(gh), plan, { rc: 1, out: '{"result":"echter Fehlschlag"}', timedOut: false, maxRuntime: 2700 }, '');
      expect(sharedState.read('blocker-sig-77')).not.toBeNull();
      expect(state.exists('blocker-sig-77')).toBe(false);
    });

    it('AC4: Sessions bleiben slot-lokal, auch wenn zwei Slots dasselbe sharedState teilen', () => {
      const stateSlot2Dir = mkdtempSync(join(tmpdir(), 'round-eval-slot2-'));
      const stateSlot2 = createStateAdapter(stateSlot2Dir);
      try {
        const { gh: gh1 } = ghDouble();
        roundEval({ gh: gh1, git: gitDouble(), state, sharedState, claims, slotId: '1', clock: CLOCK }, plan, ok, '');
        expect(state.read('session-77')).toBe('sid-1');

        const { gh: gh2 } = ghDouble();
        const okSlot2 = { rc: 0, out: '{"session_id":"sid-slot2","result":"ok"}', timedOut: false, maxRuntime: 2700 };
        roundEval(
          { gh: gh2, git: gitDouble(), state: stateSlot2, sharedState, claims, slotId: '2', clock: CLOCK },
          plan,
          okSlot2,
          '',
        );
        expect(stateSlot2.read('session-77')).toBe('sid-slot2');
        // Slot 1s Session bleibt unangetastet, obwohl beide dasselbe sharedState teilen.
        expect(state.read('session-77')).toBe('sid-1');
      } finally {
        rmSync(stateSlot2Dir, { recursive: true, force: true });
      }
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

  // F17 (#491): Textmuster fuer Limit/Uebergang duerfen nur den CLI-eigenen
  // Anteil der Ausgabe sehen, nie 'result' -- sonst entkommt ein Ticket, das
  // inhaltlich mit Fehlermeldungen/Timeouts zu tun hat, dem Eskalationsdeckel.
  describe('Textmuster sehen nur den CLI-Anteil, nicht die Agentenantwort (F17, #491)', () => {
    it('AK1: sauberer Lauf (Exit 0) mit "usage limit"/"timed out" in der Agentenantwort wird NICHT als Limit/Uebergang eingestuft', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        { rc: 0, out: '{"session_id":"s","result":"usage limit erreicht, Test ist timed out"}', timedOut: false, maxRuntime: 2700 },
        '',
      );
      expect(result.chain).toBe('continue');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(false);
      expect(state.read('transient-77')).toBeNull();
    });

    it('AK1/AK4: inhaltlicher Fehlschlag mit "usage limit"/"timed out" nur im Agententext (kein api_error_status) wird als Fehlschlag eingestuft, nicht als Limit -- failcount steigt', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        {
          rc: 1,
          out: '{"subtype":"error_max_turns","is_error":true,"result":"Test lief in usage limit und ist timed out"}',
          timedOut: false,
          maxRuntime: 2700,
        },
        '',
      );
      expect(result.status?.emoji).toBe('🔴');
      expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(false);
      expect(sharedState.read('limit-until')).toBeNull();
      // #484: failcount- lebt seit dieser Aenderung im sharedState (siehe
      // Test oben, AC1) -- der slot-lokale state bleibt dabei leer.
      expect(sharedState.read('failcount-77')).toBe('1\n');
    });

    it('AK2 (Rueckfall): ein Limit-Text OHNE JSON (kein "result" zum Ausfiltern) wird weiterhin als Limit erkannt', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        { rc: 1, out: 'Claude usage limit reached ∙ resets 3pm', timedOut: false, maxRuntime: 2700 },
        '',
      );
      expect(result.status?.emoji).toBe('🔵');
      expect(called(calls, 'edit', '77', '--add-label', 'blocked-limit')).toBe(true);
    });

    it('AK3 (Rueckfall): ein Uebergangsfehler-Text OHNE JSON wird weiterhin als Uebergang erkannt', () => {
      const { gh } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        { rc: 1, out: 'Error: overloaded_error', timedOut: false, maxRuntime: 2700 },
        '',
      );
      expect(result.status?.text).toContain('Versuch 1 von 3');
      expect(state.read('transient-77')).toBe('1');
    });

    it('AK3 (Trennschaerfe): derselbe Wortlaut ("overloaded") nur in der Agentenantwort loest KEINEN Uebergang aus, sondern einen inhaltlichen Fehlschlag', () => {
      const { gh, calls } = ghDouble();
      const result = roundEval(
        ctx(gh),
        plan,
        {
          rc: 1,
          out: '{"subtype":"error_max_turns","is_error":true,"result":"server was overloaded per log"}',
          timedOut: false,
          maxRuntime: 2700,
        },
        '',
      );
      expect(result.status?.emoji).toBe('🔴');
      expect(state.read('transient-77')).toBeNull();
      expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
    });
  });

  // ADR-0005: das Netz greift unabhaengig vom Exit-Code -- auch ein
  // "erfolgreicher" Denk-Lauf darf den Arbeitsbaum nicht beschmutzen.
  describe('Read-only-Netz fuer Denk-Rollen (ADR-0005 + #63, indexbewusster Tripwire seit #325)', () => {
    it('meldet einen sauber vorher / schmutzig nachher gewordenen Planer-Lauf rot, OHNE aufzuraeumen', () => {
      const git = gitDouble({ 'status --porcelain': ' M src/ui/shell.css' });
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh, git), { ...plan, role: 'plan', beforeDirty: '' }, ok, '');
      expect(result.status?.emoji).toBe('🔴');
      expect(result.rc).toBe(1);
      // #325: das alte Netz raeumte pauschal auf -- das kann Index-Zustand nie
      // aufloesen (checkout/clean fassen den Index nicht an) und hat deshalb
      // in Slot 2 jeden Lese-Lauf faelschlich angeklagt. Der neue Tripwire
      // meldet nur noch, er raeumt nie mehr weg.
      expect(git.run).not.toHaveBeenCalledWith(['checkout', '--', '.']);
      expect(git.run).not.toHaveBeenCalledWith(['clean', '-fd']);
      expect(called(calls, '--add-label', 'needs-answer')).toBe(true);
    });

    it('klagt NICHT an, wenn schmutzig vorher = unveraendert nachher (Fremd-Dirt bleibt liegen)', () => {
      const git = gitDouble({ 'status --porcelain': ' M docs/WORKFLOW.md' });
      const { gh, calls } = ghDouble();
      const result = roundEval(
        ctx(gh, git),
        { ...plan, role: 'plan', beforeDirty: ' M docs/WORKFLOW.md' },
        ok,
        '',
      );
      expect(result.chain).toBe('continue');
      expect(called(calls, '--add-label', 'needs-answer')).toBe(false);
      expect(git.run).not.toHaveBeenCalledWith(['checkout', '--', '.']);
      expect(git.run).not.toHaveBeenCalledWith(['clean', '-fd']);
    });

    // Index-Fall (#325): eine gestagte Fremd-Zeile ('M ' in Spalte 1) stand
    // schon vor dem Lauf da und bleibt unangetastet -- nur die ECHT neue
    // Zeile loest die Anklage aus. Das ist genau der Zustand, den das alte
    // Netz nie auflösen konnte.
    it('klagt im Index-Fall nur die neue Zeile an, die gestagte Fremd-Zeile bleibt unerwaehnt', () => {
      const git = gitDouble({ 'status --porcelain': 'M  scripts/x\n M src/y' });
      const { gh, calls } = ghDouble();
      const result = roundEval(ctx(gh, git), { ...plan, role: 'plan', beforeDirty: 'M  scripts/x' }, ok, '');
      expect(result.status?.emoji).toBe('🔴');
      const commentBody = calls.find((args) => args[0] === 'issue' && args[1] === 'comment')?.join(' ') ?? '';
      expect(commentBody).toContain('src/y');
      expect(commentBody).not.toContain('scripts/x');
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

  // #356 (B): erkennt VOR roundEval eine nicht-fortsetzbare Session, damit ein
  // vergifteter Erst-Crash nie als Eskalations-Fehlversuch zaehlt.
  describe('roundRecover', () => {
    const notFound = 'Fehler: No conversation found with session ID: 25b04165-abcd\n';

    it('(a) rc != 0 + resume gesetzt + Marker im Log -> retry, Session entfernt, Kommentar gepostet', () => {
      const { gh, calls } = ghDouble();
      const result = roundRecover(ctx(gh), { ...plan, resume: 'sid-alt' }, 1, notFound);
      expect(result).toEqual({ retry: true });
      expect(state.read('session-77')).toBeNull();
      expect(called(calls, 'comment', '77')).toBe(true);
    });

    it('(b) rc = 0 -> kein Retry, keine Seiteneffekte', () => {
      state.write('session-77', 'sid-alt');
      const { gh, calls } = ghDouble();
      const result = roundRecover(ctx(gh), { ...plan, resume: 'sid-alt' }, 0, notFound);
      expect(result).toEqual({ retry: false });
      expect(state.read('session-77')).toBe('sid-alt');
      expect(calls.length).toBe(0);
    });

    it('(c) rc != 0, aber ein anderer Fehler im Log -> kein Retry', () => {
      state.write('session-77', 'sid-alt');
      const { gh, calls } = ghDouble();
      const result = roundRecover(ctx(gh), { ...plan, resume: 'sid-alt' }, 1, 'irgendein anderer Fehler');
      expect(result).toEqual({ retry: false });
      expect(state.read('session-77')).toBe('sid-alt');
      expect(calls.length).toBe(0);
    });

    it("(d) resume = '' (frischer Start) -> kein Retry, selbst mit passendem Log", () => {
      state.write('session-77', 'sid-alt');
      const { gh, calls } = ghDouble();
      const result = roundRecover(ctx(gh), { ...plan, resume: '' }, 1, notFound);
      expect(result).toEqual({ retry: false });
      expect(state.read('session-77')).toBe('sid-alt');
      expect(calls.length).toBe(0);
    });

    it('(e) loest in KEINEM Fall buildEscalationEval/needs-answer aus', () => {
      const { gh, calls } = ghDouble();
      roundRecover(ctx(gh), { ...plan, resume: 'sid-alt' }, 1, notFound);
      expect(called(calls, '--add-label', 'needs-answer')).toBe(false);
      expect(called(calls, 'in-progress')).toBe(false);
    });

    it('entfernt die Denk-Session (session-think-<nr>) fuer eine plan/research-Rolle', () => {
      state.write('session-think-77', 'sid-alt');
      const { gh } = ghDouble();
      const result = roundRecover(ctx(gh), { ...plan, role: 'plan', resume: 'sid-alt' }, 1, notFound);
      expect(result).toEqual({ retry: true });
      expect(state.read('session-think-77')).toBeNull();
    });
  });
});
