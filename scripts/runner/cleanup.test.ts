import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStateDir } from './cleanup.js';
import type { GhAdapter } from './gh.js';

const NOW = new Date('2026-07-26T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

let dir: string;

/** Legt eine Datei an, deren mtime `ageDays` Tage zurueckliegt. */
function file(name: string, ageDays: number): void {
  const path = join(dir, name);
  writeFileSync(path, 'x', 'utf-8');
  const seconds = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
}

function ghReturning(out: string): GhAdapter {
  return { run: () => out };
}

const ghFailing: GhAdapter = {
  run: () => {
    throw new Error('gh ist nicht erreichbar');
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-cleanup-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cleanupStateDir', () => {
  it('entfernt Ticket-Dateien, die aelter als sieben Tage sind', () => {
    file('tier-101', 10);
    file('failcount-102', 30);
    file('opus-build-103', 8);
    file('opus-cap-msg-104', 9);
    file('session-105', 12);

    const removed = cleanupStateDir(dir, ghReturning(''), NOW);

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

    expect(cleanupStateDir(dir, ghReturning(''), NOW)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['session-202', 'tier-201']);
  });

  it('verschont limit-until, auch wenn es uralt ist', () => {
    file('limit-until', 99);

    expect(cleanupStateDir(dir, ghReturning(''), NOW)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['limit-until']);
  });

  it('verschont die Session des laufenden Tickets, egal wie alt sie ist', () => {
    file('session-300', 40);
    file('session-301', 40);

    const removed = cleanupStateDir(dir, ghReturning('300'), NOW);

    expect(removed).toEqual(['session-301']);
    expect(readdirSync(dir)).toEqual(['session-300']);
  });

  it('raeumt weiter auf, wenn gh fehlschlaegt -- dann ohne Schonung', () => {
    file('session-400', 40);

    expect(cleanupStateDir(dir, ghFailing, NOW)).toEqual(['session-400']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fasst fremde Dateien nicht an', () => {
    file('status-hash', 40);
    file('last-run.log', 40);
    file('round.json', 40);

    expect(cleanupStateDir(dir, ghReturning(''), NOW)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['last-run.log', 'round.json', 'status-hash']);
  });

  it('ist mit einem fehlenden Verzeichnis zufrieden', () => {
    expect(cleanupStateDir(join(dir, 'gibt-es-nicht'), ghReturning(''), NOW)).toEqual([]);
  });
});
