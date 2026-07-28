import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStateDir } from './cleanup.js';
import { createClaimAdapter, claimTake, type ClaimAdapter } from './claim.js';
import type { GhAdapter } from './gh.js';

const NOW = new Date('2026-07-26T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
const SLOT = '1';

let dir: string;
let claimsDir: string;
let claims: ClaimAdapter;

/** Legt eine Datei an, deren mtime `ageDays` Tage zurueckliegt. */
function file(name: string, ageDays: number): void {
  const path = join(dir, name);
  writeFileSync(path, 'x', 'utf-8');
  const seconds = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
}

const issueView = (state: string, ...labels: string[]) => `${state} ${labels.join(',')}`;

function ghDouble(replies: Record<string, string> = {}): GhAdapter {
  return {
    run: (args: string[]) => {
      const issue = args[2];
      return (issue && replies[issue]) ?? '';
    },
  };
}

const ghFailing: GhAdapter = {
  run: () => {
    throw new Error('gh ist nicht erreichbar');
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-cleanup-'));
  claimsDir = mkdtempSync(join(tmpdir(), 'runner-cleanup-claims-'));
  claims = createClaimAdapter(claimsDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(claimsDir, { recursive: true, force: true });
});

describe('cleanupStateDir', () => {
  it('entfernt Ticket-Dateien, die aelter als sieben Tage sind', () => {
    file('tier-101', 10);
    file('failcount-102', 30);
    file('opus-build-103', 8);
    file('opus-cap-msg-104', 9);
    file('session-105', 12);

    const removed = cleanupStateDir(dir, ghDouble(), NOW, claims, SLOT);

    expect(removed.sort()).toEqual([
      'failcount-102',
      'opus-build-103',
      'opus-cap-msg-104',
      'session-105',
      'tier-101',
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('laesst frische Dateien stehen', () => {
    file('tier-201', 6);
    file('session-202', 1);

    expect(cleanupStateDir(dir, ghDouble(), NOW, claims, SLOT)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['session-202', 'tier-201']);
  });

  it('verschont limit-until, auch wenn es uralt ist', () => {
    file('limit-until', 99);

    expect(cleanupStateDir(dir, ghDouble(), NOW, claims, SLOT)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['limit-until']);
  });

  it('verschont die Session des laufenden Tickets DIESES Slots, egal wie alt sie ist', () => {
    file('session-300', 40);
    file('session-301', 40);
    claimTake(claims, 300, SLOT);

    const removed = cleanupStateDir(dir, ghDouble({ '300': issueView('OPEN', 'in-progress') }), NOW, claims, SLOT);

    expect(removed).toEqual(['session-301']);
    expect(readdirSync(dir)).toEqual(['session-300']);
  });

  // Korrektur 5 (#204): das in-progress-Ticket eines ANDEREN Slots darf diesen
  // Slot nicht dazu bringen, seine EIGENE Session zu verschonen -- er hat gar
  // keine laufende Session fuer ein fremdes Ticket, und wuerde sonst seine
  // eigene loeschen, weil `keep` auf ein fremdes Ticket zeigt.
  it('schont NICHT die Session eines Tickets, das ein anderer Slot beansprucht', () => {
    file('session-400', 40);
    claimTake(claims, 999, '2'); // fremder Claim, fremder Slot

    const removed = cleanupStateDir(dir, ghDouble({ '999': issueView('OPEN', 'in-progress') }), NOW, claims, SLOT);

    expect(removed).toEqual(['session-400']);
  });

  it('raeumt weiter auf, wenn gh fehlschlaegt -- dann ohne Schonung', () => {
    file('session-400', 40);
    claimTake(claims, 400, SLOT);

    expect(cleanupStateDir(dir, ghFailing, NOW, claims, SLOT)).toEqual(['session-400']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fasst fremde Dateien nicht an', () => {
    file('status-hash', 40);
    file('last-run.log', 40);
    file('round.json', 40);

    expect(cleanupStateDir(dir, ghDouble(), NOW, claims, SLOT)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['last-run.log', 'round.json', 'status-hash']);
  });

  it('ist mit einem fehlenden Verzeichnis zufrieden', () => {
    expect(cleanupStateDir(join(dir, 'gibt-es-nicht'), ghDouble(), NOW, claims, SLOT)).toEqual([]);
  });
});
