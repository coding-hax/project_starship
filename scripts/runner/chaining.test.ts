// Ticket-Chaining (#61), TS-Seite -- das Gegenstueck zu
// scripts/tests/chaining.test.sh, gefordert von #203 AK4.
//
// Arbeitsteilung nach S6: die SCHLEIFE bleibt in Bash (main() in
// claude-runner.sh zaehlt Runden gegen MAX_ROUNDS und TICK_BUDGET), die
// ENTSCHEIDUNG, ob es ueberhaupt eine weitere Runde geben darf, faellt in
// roundEval(). Diese Suite deckt die Entscheidung ab -- Fall fuer Fall
// dieselben Ausgaenge, die chaining.test.sh als Rundenzahl beobachtet.
// Die Schleife selbst bleibt durch chaining.test.sh belegt; genau deshalb
// wird die Bash-Suite nicht abgeloest.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import type { GitAdapter } from './git';
import { createFixedClock } from './clock';
import { createStateAdapter, type StateAdapter } from './state';
import { createClaimAdapter } from './claim';
import { roundEval, type RoundContext, type RoundRun } from './round';

const CLOCK = createFixedClock(new Date('2026-07-26T09:22:00'));

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

const gitDouble = (): GitAdapter => ({ run: vi.fn(() => '') });

/** `gh issue view N --json labels -q .labels[].name` -- eine Zeile je Label. */
const labelsAre = (...names: string[]) => ({
  match: (args: string[]) => args[0] === 'issue' && args[1] === 'view' && args.includes('labels'),
  reply: names.join('\n'),
});

describe('Chaining-Entscheidung (#61)', () => {
  let dir: string;
  let state: StateAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chaining-'));
    state = createStateAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan: RoundRun = {
    kind: 'run',
    status: { title: '', emoji: '', text: '' },
    issue: 70,
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
  const claims = createClaimAdapter(mkdtempSync(join(tmpdir(), 'chaining-claims-')));

  const ctx = (gh: GhAdapter): RoundContext => ({
    gh,
    git: gitDouble(),
    state,
    sharedState: state,
    claims,
    slotId: '1',
    clock: CLOCK,
  });
  const clean = { rc: 0, out: '{"session_id":"sid-1","result":"ok"}', timedOut: false, maxRuntime: 2700 };

  // AC1/AC3a in chaining.test.sh: nur dieser Ausgang laesst den Tick eine
  // weitere Runde starten -- so kommt dort der teure plan -> ready-Wechsel
  // im SELBEN Tick zustande.
  it('erlaubt eine weitere Runde nach einem sauberen Lauf', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, clean, '');

    expect(result.chain).toBe('continue');
    expect(result.rc).toBe(0);
  });

  // AC1: fragt der Agent an SEINEM Ticket nach, ist der Tick vorbei --
  // in der Bash-Suite messbar als genau ein claude-Aufruf.
  it('bricht ab, wenn der Agent an diesem Ticket eine Frage gestellt hat', () => {
    const { gh } = ghDouble([labelsAre('ready', 'needs-answer')]);
    const result = roundEval(ctx(gh), plan, clean, '');

    expect(result.chain).toBe('stop');
  });

  // AC4: Notbremse (MAX_RUNTIME ueberschritten, Prozessgruppe gekillt).
  it('bricht nach der Notbremse ab', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, { ...clean, rc: 143, out: '', timedOut: true }, '');

    expect(result.chain).toBe('stop');
  });

  // AC5: harter Fehlschlag ohne Limit und ohne offene Frage.
  it('bricht bei einem harten Fehlschlag ab', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, { ...clean, rc: 1, out: 'irgendwas ging schief' }, '');

    expect(result.chain).toBe('stop');
  });

  // Kontingent erschoepft: der Tick endet, das Weiterlaufen uebernimmt das
  // limit-until-Gate beim naechsten Start.
  it('bricht ab, wenn das Kontingent erschoepft ist', () => {
    const { gh } = ghDouble();
    const limited = {
      ...clean,
      rc: 1,
      out: '{"api_error_status":429,"result":"5-hour limit reached ∙ resets 3pm"}',
    };
    const result = roundEval(ctx(gh), plan, limited, '');

    expect(result.chain).toBe('stop');
    expect(state.read('limit-until')).not.toBeNull();
  });

  // Die Schleife in Bash gibt didWork/lastIssue in die naechste Runde weiter:
  // daran erkennt roundPlan, dass ein leerer Tick trotzdem produktiv war
  // (🟢 statt ⚪️) und welches Ticket zuletzt lief.
  it('reicht das gebaute Ticket an die naechste Runde weiter', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, clean, '');

    expect(result.didWork).toBe(true);
    expect(result.lastIssue).toBe('70');
  });

  it('meldet einen erfolglosen Lauf nicht als geleistete Arbeit', () => {
    const { gh } = ghDouble();
    const result = roundEval(ctx(gh), plan, { ...clean, rc: 1, out: 'kaputt' }, '');

    expect(result.didWork).toBe(false);
  });
});
