import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhAdapter } from './gh';
import {
  claimFilter,
  claimRelease,
  claimSweep,
  claimTake,
  createClaimAdapter,
  SWEEP_GRACE_MS,
  type ClaimAdapter,
} from './claim';
import type { QueueIssue } from './queue';

function ghDouble(routes: { match: (args: string[]) => boolean; reply: string }[] = []) {
  const gh: GhAdapter = {
    run: vi.fn((args: string[]) => {
      const hit = routes.find((route) => route.match(args));
      return hit ? hit.reply : '';
    }),
  };
  return gh;
}

const issueView = (state: string, ...labels: string[]) => ({
  match: (args: string[]) => args[0] === 'issue' && args[1] === 'view',
  reply: `${state} ${labels.join(',')}`,
});

describe('claim.ts (#204)', () => {
  let dir: string;
  let claims: ClaimAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claims-'));
    claims = createClaimAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('claimTake', () => {
    it('gewinnt einen freien Claim (Verzeichnis existiert noch nicht)', () => {
      expect(claimTake(claims, 100, '1')).toBe(true);
      expect(claims.readSlot(100)).toBe('1');
    });

    it('setzt fort, wenn der Claim schon demselben Slot gehört', () => {
      claimTake(claims, 101, '2');
      expect(claimTake(claims, 101, '2')).toBe(true);
    });

    it('scheitert, wenn ein anderer Slot den Claim schon hält', () => {
      claimTake(claims, 102, '1');
      expect(claimTake(claims, 102, '2')).toBe(false);
      expect(claims.readSlot(102)).toBe('1');
    });

    // ADR-0020 (#449): genau EINER von zwei gleichzeitigen `claimTake`-Aufrufen
    // gewinnt -- die zweite `rename` scheitert am nicht-leeren Ziel, es gibt
    // nie einen leeren Zwischenzustand, den beide als frei lesen koennten.
    it('laesst bei zwei Slots auf demselben Ticket nur genau einen gewinnen (AK1)', () => {
      const first = claimTake(claims, 105, '1');
      const second = claimTake(claims, 105, '2');
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(claims.readSlot(105)).toBe(first ? '1' : '2');
    });

    // Korrektur 7 / ADR-0020: bricht ein Lauf zwischen mkdir und dem
    // Schreiben der slot-Datei ab, bleibt ein leeres Verzeichnis zurück (kein
    // Inhalt). Das muss weiterhin als FREI gelten und per `rename` ersetzbar
    // sein, sonst ist das Ticket für immer tot -- kein Sweep hilft, solange
    // 'in-progress' klebt (AK2).
    it('behandelt ein leeres Claim-Verzeichnis (abgebrochener Altlauf) als frei', () => {
      mkdirSync(join(dir, '103'));
      expect(claims.readSlot(103)).toBe('');
      expect(claimTake(claims, 103, '2')).toBe(true);
      expect(claims.readSlot(103)).toBe('2');
    });

    // ADR-0020: das fruehere Mikro-Loch -- ein Verzeichnis mit (leerer)
    // slot-Datei ist fuer `rename` NICHT-leer und daher nicht mehr stehlbar.
    // Anders als der Fall oben (komplett leeres Verzeichnis) ist hier bereits
    // Inhalt da; genau dieses Loch schliesst der atomare Claim.
    it('behandelt eine leere slot-Datei NICHT mehr als frei (geschlossenes Mikro-Loch)', () => {
      mkdirSync(join(dir, '104'));
      writeFileSync(join(dir, '104', 'slot'), '');
      expect(claimTake(claims, 104, '3')).toBe(false);
      expect(claims.readSlot(104)).toBe('');
    });
  });

  describe('claimFilter', () => {
    const snapshot: QueueIssue[] = [
      { number: 10, labels: [], createdAt: '2026-01-01' },
      { number: 11, labels: [], createdAt: '2026-01-01' },
      { number: 12, labels: [], createdAt: '2026-01-01' },
    ];

    it('lässt unbeanspruchte und eigene Tickets durch, wirft fremde raus', () => {
      claimTake(claims, 11, '1'); // eigen
      claimTake(claims, 12, '2'); // fremd
      const filtered = claimFilter(snapshot, claims, '1');
      expect(filtered.map((i) => i.number)).toEqual([10, 11]);
    });
  });

  describe('claimSweep', () => {
    it('lässt einen frischen Claim unangetastet, auch ohne in-progress (Schonfrist, Korrektur 6)', () => {
      claimTake(claims, 200, '1');
      const gh = ghDouble([issueView('OPEN', 'ready')]);
      claimSweep(claims, gh, Date.now());
      expect(claims.readSlot(200)).toBe('1');
    });

    it('räumt einen verwaisten Claim weg, wenn das Ticket geschlossen ist', () => {
      claimTake(claims, 201, '1');
      const gh = ghDouble([issueView('CLOSED')]);
      // ageMs wird über now-mtime bestimmt; wir setzen "now" weit genug voraus.
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(201)).toBeNull();
    });

    it('räumt einen alten Claim weg, dessen Ticket kein in-progress mehr trägt', () => {
      claimTake(claims, 202, '1');
      const gh = ghDouble([issueView('OPEN', 'ready')]); // in-progress abgenommen
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(202)).toBeNull();
    });

    it('behält einen alten Claim, dessen Ticket weiterhin offen und in-progress ist', () => {
      claimTake(claims, 203, '1');
      const gh = ghDouble([issueView('OPEN', 'in-progress')]);
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(203)).toBe('1');
    });

    // #326: pickTicket() setzt 'in-progress' nur fuer die Bau-Rolle -- ein
    // Plan- oder Recherche-Lauf traegt stattdessen weiterhin 'plan'/'research'.
    // Ohne diese beiden ebenfalls als "noch aktiv" zu werten, raeumte der Sweep
    // den Claim eines laengeren Planer-Laufs nach der Schonfrist weg, obwohl
    // die Rolle noch nicht fertig war -- ein zweiter Slot konnte dieselbe
    // Rolle fuer dasselbe Ticket danach ein zweites Mal beginnen (#216, 28.07.26).
    it('behält einen alten Claim, dessen Ticket weiterhin einen Plan-Lauf traegt', () => {
      claimTake(claims, 210, '1');
      const gh = ghDouble([issueView('OPEN', 'plan')]);
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(210)).toBe('1');
    });

    it('behält einen alten Claim, dessen Ticket weiterhin einen Recherche-Lauf traegt', () => {
      claimTake(claims, 211, '1');
      const gh = ghDouble([issueView('OPEN', 'research')]);
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(211)).toBe('1');
    });

    it('räumt einen alten Plan-Claim weg, sobald das Label auf ready geflippt ist', () => {
      claimTake(claims, 212, '1');
      const gh = ghDouble([issueView('OPEN', 'ready')]); // 'plan' abgenommen, Planung fertig
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(212)).toBeNull();
    });

    // #387 AC6: seit #387 traegt ein Denk-Ticket zusaetzlich 'in-progress'
    // (sichtbar + haelt den Claim ueber isStillClaimable() bereits ab #326).
    // Dieser Fall bestand vorher nicht, weil pickTicket() 'in-progress' nur
    // fuer Bau-Tickets setzte -- jetzt ist er der Regelfall fuer einen
    // laufenden Denk-Lauf.
    it('behält einen alten Claim eines Denk-Tickets, das zusaetzlich in-progress traegt', () => {
      claimTake(claims, 213, '1');
      const gh = ghDouble([issueView('OPEN', 'in-progress', 'plan')]);
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(213)).toBe('1');
    });

    it('behält einen alten Claim, wenn der gh-Adapter wirft (Netz/Rate-Limit, #482)', () => {
      claimTake(claims, 220, '1');
      const gh: GhAdapter = {
        run: vi.fn(() => {
          throw new Error('gh: network');
        }),
      };
      claimSweep(claims, gh, Date.now() + SWEEP_GRACE_MS + 1000);
      expect(claims.readSlot(220)).toBe('1');
    });

    it('sweept einen Claim jünger als die maximale Laufzeit nicht, auch wenn gh CLOSED meldet (#482)', () => {
      claimTake(claims, 221, '1');
      const gh = ghDouble([issueView('CLOSED')]);
      // 44 min < SWEEP_GRACE_MS (50 min) -- Schonfrist greift, gh wird gar nicht gefragt.
      claimSweep(claims, gh, Date.now() + 44 * 60 * 1000);
      expect(claims.readSlot(221)).toBe('1');
    });
  });

  it('claimRelease entfernt einen Claim vollständig (rm -rf)', () => {
    claimTake(claims, 300, '1');
    claimRelease(claims, 300);
    expect(claims.readSlot(300)).toBeNull();
  });

  it('claimRelease auf einen nicht existenten Claim ist kein Fehler', () => {
    expect(() => claimRelease(claims, 999)).not.toThrow();
  });
});
