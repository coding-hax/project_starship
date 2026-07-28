import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateStatus, createFleetAdapter, effectiveLead, STALE_MS, type FleetAdapter } from './fleet';

const NOW = new Date('2026-07-28T12:00:00Z').getTime();

let dir: string;
let fleet: FleetAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-'));
  fleet = createFleetAdapter(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FleetAdapter', () => {
  it('schreibt und liest den Zustand eines Slots', () => {
    fleet.write('1', { emoji: '🟠', title: 'arbeitet an #70', text: 'Details' }, NOW);
    expect(fleet.readAll()).toEqual([{ slotId: '1', emoji: '🟠', title: 'arbeitet an #70', text: 'Details', updatedAtMs: NOW }]);
  });

  it('content:null behaelt den vorherigen Text, hebt aber den Herzschlag an', () => {
    fleet.write('1', { emoji: '🟠', title: 'arbeitet an #70', text: 'Details' }, NOW);
    fleet.write('1', null, NOW + 60_000);
    expect(fleet.readAll()).toEqual([{ slotId: '1', emoji: '🟠', title: 'arbeitet an #70', text: 'Details', updatedAtMs: NOW + 60_000 }]);
  });

  it('content:null OHNE vorherigen Zustand schreibt einen Platzhalter statt zu werfen', () => {
    fleet.write('2', null, NOW);
    const [state] = fleet.readAll();
    expect(state?.slotId).toBe('2');
    expect(state?.title).not.toBe('');
  });

  it('readAll sortiert nach SLOT_ID, nicht nach Schreibreihenfolge', () => {
    fleet.write('3', { emoji: '🟢', title: 'a', text: 'a' }, NOW);
    fleet.write('1', { emoji: '🟢', title: 'b', text: 'b' }, NOW);
    fleet.write('2', { emoji: '🟢', title: 'c', text: 'c' }, NOW);
    expect(fleet.readAll().map((s) => s.slotId)).toEqual(['1', '2', '3']);
  });

  it('ohne slots/-Verzeichnis liefert readAll ein leeres Array', () => {
    expect(fleet.readAll()).toEqual([]);
  });
});

describe('effectiveLead (#204 AK5)', () => {
  it('Kaltstart -- noch kein Zustand bekannt -> LEAD_SLOT bleibt lead', () => {
    expect(effectiveLead([], ['1', '2', '3'], '1', NOW)).toBe('1');
  });

  it('LEAD_SLOT hat einen frischen Herzschlag -> bleibt lead', () => {
    const states = [{ slotId: '1', emoji: '🟢', title: '', text: '', updatedAtMs: NOW }];
    expect(effectiveLead(states, ['1', '2', '3'], '1', NOW)).toBe('1');
  });

  it('LEAD_SLOT ist veraltet -> der niedrigste frische Slot uebernimmt', () => {
    const states = [
      { slotId: '1', emoji: '🟢', title: '', text: '', updatedAtMs: NOW - STALE_MS - 1 },
      { slotId: '3', emoji: '🟢', title: '', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🟢', title: '', text: '', updatedAtMs: NOW },
    ];
    expect(effectiveLead(states, ['1', '2', '3'], '1', NOW)).toBe('2');
  });

  it('sind ALLE veraltet, bleibt LEAD_SLOT die Antwort (ruhender Leitslot statt keiner)', () => {
    const states = [
      { slotId: '1', emoji: '🟢', title: '', text: '', updatedAtMs: NOW - STALE_MS - 1 },
      { slotId: '2', emoji: '🟢', title: '', text: '', updatedAtMs: NOW - STALE_MS - 1 },
    ];
    expect(effectiveLead(states, ['1', '2'], '1', NOW)).toBe('1');
  });
});

describe('aggregateStatus (#204 AK4/AK9)', () => {
  it('AK9: genau ein Slot-Zustand, slotCount 1 -> unveraendert durchgereicht, keine "Flotte"-Umrahmung', () => {
    const states = [{ slotId: '1', emoji: '🟠', title: 'arbeitet an #70 (sonnet, seit 14:00)', text: 'Details' }];
    const withTs = states.map((s) => ({ ...s, updatedAtMs: NOW }));
    expect(aggregateStatus(withTs, 1, '1', '1', NOW)).toEqual({
      title: 'arbeitet an #70 (sonnet, seit 14:00)',
      emoji: '🟠',
      text: 'Details',
    });
  });

  it('ohne jeden Slot-Zustand gibt es nichts zu schreiben', () => {
    expect(aggregateStatus([], 3, '1', '1', NOW)).toBeNull();
  });

  it('AK4: mehrere Slots -> EIN Titel mit "N von M aktiv", eine Zeile je Slot', () => {
    const states = [
      { slotId: '1', emoji: '🟠', title: 'arbeitet an #70', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🟢', title: 'CI läuft für #186', text: '', updatedAtMs: NOW },
      { slotId: '3', emoji: '🟡', title: 'wartet auf dich (#159)', text: '', updatedAtMs: NOW },
    ];
    const result = aggregateStatus(states, 3, '1', '1', NOW);
    expect(result?.title).toBe('Runner-Flotte · 3 von 3 aktiv');
    expect(result?.text).toContain('Slot 1:** arbeitet an #70');
    expect(result?.text).toContain('Slot 2:** CI läuft für #186');
    expect(result?.text).toContain('Slot 3:** wartet auf dich (#159)');
  });

  it('das schwerwiegendste Emoji unter den aktiven Slots bestimmt das Titel-Emoji (🔴 schlaegt 🟢)', () => {
    const states = [
      { slotId: '1', emoji: '🟢', title: 'nichts offen', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🔴', title: 'Fehler bei #99', text: '', updatedAtMs: NOW },
    ];
    expect(aggregateStatus(states, 2, '1', '1', NOW)?.emoji).toBe('🔴');
  });

  it('ein veralteter Slot zaehlt nicht zu "aktiv" und erscheint mit 💤 statt seinem Emoji', () => {
    const states = [
      { slotId: '1', emoji: '🟠', title: 'arbeitet an #70', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🟠', title: 'arbeitet an #12', text: '', updatedAtMs: NOW - STALE_MS - 1 },
    ];
    const result = aggregateStatus(states, 2, '1', '1', NOW);
    expect(result?.title).toBe('Runner-Flotte · 1 von 2 aktiv');
    expect(result?.text).toContain('💤 **Slot 2:**');
  });

  // AK5: der Text muss die Uebernahme nennen -- vom Handy aus ist das die
  // einzige Stelle, an der eine Leitungsuebernahme sichtbar wird.
  it('AK5: weicht der effektive Leitslot vom konfigurierten ab, nennt der Text die Uebernahme', () => {
    const states = [
      { slotId: '1', emoji: '🟢', title: 'x', text: '', updatedAtMs: NOW - STALE_MS - 1 },
      { slotId: '2', emoji: '🟢', title: 'y', text: '', updatedAtMs: NOW },
    ];
    const result = aggregateStatus(states, 2, '1', '2', NOW);
    expect(result?.text).toContain('Leitslot übernommen');
    expect(result?.text).toContain('Slot 1 antwortet nicht mehr');
    expect(result?.text).toContain('Slot 2 führt Status');
  });

  it('ohne Uebernahme fehlt die Uebernahme-Notiz', () => {
    const states = [{ slotId: '1', emoji: '🟢', title: 'x', text: '', updatedAtMs: NOW }];
    expect(aggregateStatus(states, 2, '1', '1', NOW)?.text).not.toContain('Leitslot übernommen');
  });

  // #331 AK3/AK5: 🔴 darf im Kopf nie von 🟡 verdeckt werden -- genau das
  // Muster aus dem Vorfall vom 28.07.26 (23:26 Uhr), wo die Anzeige "wartet
  // auf dich" zeigte, obwohl ein Slot tatsaechlich auf Fehler stand.
  it('AK3/AK5: 🔴 schlaegt 🟡 im Titel-Emoji', () => {
    const states = [
      { slotId: '1', emoji: '🟡', title: 'wartet auf dich (#325)', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🔴', title: 'Fehler bei #325', text: '', updatedAtMs: NOW },
    ];
    expect(aggregateStatus(states, 2, '1', '1', NOW)?.emoji).toBe('🔴');
  });

  // #331 AK2: eine zehn Minuten alte Zeile muss sichtbar aelter aussehen als
  // eine gerade erst geschriebene -- das reine 💤-Symbol greift erst ab
  // STALE_MS (90 Min.) und waere hier blind.
  it('AK2: jede Zeile traegt ihr eigenes Alter, unabhaengig vom 💤-Schnitt', () => {
    const states = [
      { slotId: '1', emoji: '🟢', title: 'arbeitet an #70', text: '', updatedAtMs: NOW },
      { slotId: '2', emoji: '🟠', title: 'arbeitet an #12', text: '', updatedAtMs: NOW - 10 * 60_000 },
    ];
    const result = aggregateStatus(states, 2, '1', '1', NOW);
    expect(result?.text).toContain('Slot 1:** arbeitet an #70 _(gerade eben)_');
    expect(result?.text).toContain('Slot 2:** arbeitet an #12 _(vor 10 Min.)_');
  });

  it('AK2: das Alter waechst auch ueber Stunden hinweg lesbar', () => {
    const states = [{ slotId: '1', emoji: '🟢', title: 'x', text: '', updatedAtMs: NOW - 125 * 60_000 }];
    const result = aggregateStatus(states, 2, '1', '1', NOW);
    expect(result?.text).toContain('_(vor 2 Std. 5 Min.)_');
  });
});
