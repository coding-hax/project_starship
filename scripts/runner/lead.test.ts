import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLead, createLeadAdapter, type LeadAdapter } from './lead';

const TTL = 90 * 60 * 1000; // = STALE_MS aus fleet.ts

describe('lead.ts (#488, F14)', () => {
  let dir: string;
  let leaseDir: string;
  let lead: LeadAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lead-'));
    leaseDir = join(dir, 'lead');
    lead = createLeadAdapter(leaseDir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('acquireLead', () => {
    // AK1: zwei Slots, die denselben Herzschlag GENAU am Frischerand
    // (NOW-STALE_MS) unterschiedlich auswerten -- der eine haelt LEAD_SLOT
    // noch fuer frisch (entitled=1), der andere gerade nicht mehr
    // (entitled=2) -- duerfen trotzdem nie beide Leitslot sein: die Lease
    // entscheidet, nicht die je Slot berechnete Meinung.
    it('laesst am exakten Frischerand nur einen von zwei Slots Leitslot sein (AK1)', () => {
      const now = 1_000_000_000;
      expect(acquireLead(lead, '1', '1', now, TTL)).toBe('1');
      expect(lead.holds('1')).toBe(true);

      // Slot 2 liest denselben Rand als "Slot 1 veraltet" und haelt sich
      // selbst fuer entitled -- die frische Lease von Slot 1 gewinnt trotzdem.
      const holder = acquireLead(lead, '2', '2', now, TTL);
      expect(holder).toBe('1');
      expect(lead.holds('2')).toBe(false);
      expect(lead.holds('1')).toBe(true);
    });

    // AK2: der Leitslot ist wirklich tot (Lease abgelaufen), der naechste
    // entitled-Slot uebernimmt automatisch -- ohne Mensch, ohne zwei Halter.
    it('uebernimmt bei abgelaufener Lease automatisch fuer den entitled-Slot (AK2)', () => {
      const start = 1_000_000_000;
      acquireLead(lead, '1', '1', start, TTL);

      const later = start + TTL + 1;
      const holder = acquireLead(lead, '2', '2', later, TTL);
      expect(holder).toBe('2');
      expect(lead.holds('2')).toBe(true);
      expect(lead.holds('1')).toBe(false);
    });

    // Eine lebende Lease eines anderen Slots darf nicht "gestohlen" werden,
    // auch wenn der lokale Slot sich selbst fuer entitled haelt.
    it('stiehlt keine lebende Fremd-Lease', () => {
      const now = 1_000_000_000;
      acquireLead(lead, '1', '1', now, TTL);

      const holder = acquireLead(lead, '2', '2', now + 1000, TTL);
      expect(holder).toBe('1');
      expect(lead.holds('2')).toBe(false);
    });

    it('gibt die Lease ab dem entitled-Slot frei, wenn LEAD_SLOT wieder frisch ist', () => {
      const now = 1_000_000_000;
      // Slot 2 haelt (Failover war noetig), jetzt ist Slot 1 wieder entitled.
      acquireLead(lead, '2', '2', now, TTL);
      expect(lead.holds('2')).toBe(true);

      const holder = acquireLead(lead, '1', '2', now + 1000, TTL);
      expect(holder).toBe('1');
      expect(lead.holds('2')).toBe(false);
    });
  });

  describe('tryReap', () => {
    it('raeumt genau einmal weg, wenn zwei Reaper gleichzeitig antreten', () => {
      const now = 1_000_000_000;
      lead.tryAcquire('1', now, TTL);

      const later = now + TTL + 1;
      const results = [lead.tryReap(later), lead.tryReap(later)];
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(lead.read()).toBeNull();
    });

    it('raeumt eine lebende Lease nicht weg', () => {
      const now = 1_000_000_000;
      lead.tryAcquire('1', now, TTL);
      expect(lead.tryReap(now + 1000)).toBe(false);
      expect(lead.read()).not.toBeNull();
    });

    it('meldet nichts zum Raeumen, wenn keine Lease existiert', () => {
      expect(lead.tryReap(1_000_000_000)).toBe(false);
    });
  });

  describe('tryAcquire', () => {
    it('gewinnt eine freie Lease', () => {
      expect(lead.tryAcquire('1', 1000, TTL)).toBe(true);
      expect(lead.read()).toEqual({ slot: '1', expiresAtMs: 1000 + TTL });
    });

    it('scheitert, wenn schon eine Lease existiert (auch abgelaufen -- ohne vorherigen Reap)', () => {
      lead.tryAcquire('1', 1000, TTL);
      expect(lead.tryAcquire('2', 1000 + TTL + 1, TTL)).toBe(false);
    });

    // Analog claim.ts: POSIX `rename` scheitert nur an einem NICHT-leeren
    // Zielverzeichnis -- ein leeres Verzeichnis (abgebrochener Lauf zwischen
    // mkdir und writeFileSync) zaehlt weiterhin als FREI und ist per `rename`
    // ersetzbar, sonst waere die Lease nach einem Absturz fuer immer blockiert.
    it('behandelt ein leeres Lease-Verzeichnis (abgebrochener Altlauf) als frei', () => {
      mkdirSync(leaseDir, { recursive: true });
      expect(lead.read()).toBeNull();
      expect(lead.tryAcquire('1', 1000, TTL)).toBe(true);
      expect(lead.read()).toEqual({ slot: '1', expiresAtMs: 1000 + TTL });
    });
  });

  describe('renew/holds/release', () => {
    it('erneuert nur fuer den aktuellen Halter', () => {
      lead.tryAcquire('1', 1000, TTL);
      lead.renew('2', 2000, TTL);
      expect(lead.read()).toEqual({ slot: '1', expiresAtMs: 1000 + TTL });

      lead.renew('1', 2000, TTL);
      expect(lead.read()).toEqual({ slot: '1', expiresAtMs: 2000 + TTL });
    });

    it('gibt nur frei, wenn der freigebende Slot auch haelt', () => {
      lead.tryAcquire('1', 1000, TTL);
      lead.release('2');
      expect(lead.holds('1')).toBe(true);

      lead.release('1');
      expect(lead.holds('1')).toBe(false);
      expect(lead.read()).toBeNull();
    });
  });
});
