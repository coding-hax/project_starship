// Fuehrung per Lease bei mehreren Slots (#488, F14): wer die globalen
// Waechter (claimSweep, Statusveroeffentlichung, reopenFalselyClosedIssues)
// fahren darf, entsteht nicht mehr aus einer je Slot fuer sich berechneten
// Meinung ueber den Herzschlag (effectiveLead() in fleet.ts) -- rund um die
// Frischegrenze (STALE_MS) lesen zwei Slots denselben Zustand unterschiedlich
// und halten sich beide fuer zustaendig. Stattdessen entscheidet eine Lease
// unter SHARED_DIR/lead/, uebernommen per atomarer Umbenennung (dieselbe
// Technik wie der Claim, ADR-0020/claim.ts): genau ein Gewinner.
//
// effectiveLead() bleibt unveraendert die Quelle der BERECHTIGUNG (bevorzugt
// LEAD_SLOT, sonst niedrigster frischer Slot, steuert die Uebernahme-Notiz in
// aggregateStatus() und die Failover-Reihenfolge). Die Lease liefert den
// gegenseitigen AUSSCHLUSS obendrauf: auch wenn zwei Slots am Frischerand
// unterschiedlich rechnen, wer entitled ist, kann nur einer die Lease halten.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface LeaseHolder {
  slot: string;
  expiresAtMs: number;
}

export interface LeadAdapter {
  /** null = keine Lease vorhanden oder Inhalt kaputt (tolerant, kein Fehler). */
  read(): LeaseHolder | null;
  /** true = Lease HIER atomar fuer `slotId` angelegt (Ziel existierte nicht). */
  tryAcquire(slotId: string, now: number, ttlMs: number): boolean;
  /** true = eine ABGELAUFENE Lease wurde HIER weggeraeumt (Ziel existierte, war abgelaufen). */
  tryReap(now: number): boolean;
  /** Nur wenn `slotId` aktuell haelt: Ablaufzeit erneuern. */
  renew(slotId: string, now: number, ttlMs: number): void;
  holds(slotId: string): boolean;
  /** Nur wenn `slotId` aktuell haelt: Lease freigeben (naechster Tick uebernimmt). */
  release(slotId: string): void;
}

export function createLeadAdapter(baseDir: string): LeadAdapter {
  const holderFile = () => join(baseDir, 'holder');
  const tmpDirOf = () => join(baseDir, `..`, `.lead-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);

  function readRaw(): LeaseHolder | null {
    if (!existsSync(baseDir)) return null;
    try {
      const raw = JSON.parse(readFileSync(holderFile(), 'utf-8')) as LeaseHolder;
      if (typeof raw.slot !== 'string' || typeof raw.expiresAtMs !== 'number') return null;
      return raw;
    } catch {
      return null;
    }
  }

  function writeLease(slotId: string, now: number, ttlMs: number): boolean {
    const tmp = tmpDirOf();
    mkdirSync(tmp, { recursive: true });
    const holder: LeaseHolder = { slot: slotId, expiresAtMs: now + ttlMs };
    writeFileSync(join(tmp, 'holder'), JSON.stringify(holder), 'utf-8');
    try {
      // `rename` auf ein nicht-leeres Zielverzeichnis scheitert atomar (POSIX
      // ENOTEMPTY) -- genau ein Gewinner, kein leerer Zwischenzustand (analog
      // claimAtomic in claim.ts, ADR-0020).
      renameSync(tmp, baseDir);
      return true;
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      return false;
    }
  }

  return {
    read: readRaw,
    tryAcquire(slotId, now, ttlMs) {
      return writeLease(slotId, now, ttlMs);
    },
    tryReap(now) {
      const cur = readRaw();
      if (cur === null || cur.expiresAtMs > now) return false;
      const graveyard = join(baseDir, '..', `.lead-reap-${process.pid}-${Math.random().toString(36).slice(2)}`);
      try {
        // Wie claimAtomic: `rename` scheitert atomar, wenn ein zweiter Reaper
        // die Lease zwischen readRaw() und hier schon weggeraeumt hat (ENOENT)
        // -- genau ein Gewinner raeumt tatsaechlich weg.
        renameSync(baseDir, graveyard);
      } catch {
        return false;
      }
      rmSync(graveyard, { recursive: true, force: true });
      return true;
    },
    renew(slotId, now, ttlMs) {
      const cur = readRaw();
      if (cur === null || cur.slot !== slotId) return;
      writeFileSync(holderFile(), JSON.stringify({ slot: slotId, expiresAtMs: now + ttlMs }), 'utf-8');
    },
    holds(slotId) {
      const cur = readRaw();
      return cur !== null && cur.slot === slotId;
    },
    release(slotId) {
      const cur = readRaw();
      if (cur === null || cur.slot !== slotId) return;
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

/**
 * Versucht, `slotId` zum Leitslot zu machen, und liefert den Halter NACH dem
 * Versuch (nicht zwingend `slotId`). `entitled` ist das Ergebnis von
 * effectiveLead() -- wer nach Herzschlag-Regeln DUERFTE. Nur der entitled-Slot
 * tritt bei fehlender/abgelaufener Lease an (kein Thundering Herd, bewahrt die
 * niedrigste-frische-Failover-Reihenfolge).
 */
export function acquireLead(lead: LeadAdapter, entitled: string, slotId: string, now: number, ttlMs: number): string {
  const cur = lead.read();
  if (cur !== null && cur.expiresAtMs > now) {
    if (cur.slot === slotId) {
      if (entitled === slotId) {
        lead.renew(slotId, now, ttlMs);
        return slotId;
      }
      // Nicht mehr entitled (LEAD_SLOT wieder frisch o. ae.): Lease
      // hergeben, statt sie bis zum Ablauf festzuhalten -- naechster Tick
      // gibt dem entitled-Slot die Chance, sie zu uebernehmen. Niemand haelt
      // sie mehr HIER und JETZT -- `entitled` ist der naechste Anwaerter.
      lead.release(slotId);
      return entitled;
    }
    return cur.slot;
  }
  if (slotId !== entitled) return cur?.slot ?? entitled;
  if (cur !== null) lead.tryReap(now);
  return lead.tryAcquire(slotId, now, ttlMs) ? slotId : (lead.read()?.slot ?? entitled);
}
