import { describe, expect, it } from 'vitest';
import {
  compareOutboxOrder,
  mutate,
  nextOutboxSeq,
  overSyncErrorThreshold,
  sortByOrder,
  SYNC_ERROR_THRESHOLD,
} from './outbox';
import type { OutboxEntry } from './types';

function entry(attempts: number): OutboxEntry {
  return {
    id: `m-${attempts}`,
    table: 'tasks',
    rowId: 'r1',
    op: 'upsert',
    payload: {},
    updatedAt: new Date().toISOString(),
    baseSeq: null,
    createdAt: new Date().toISOString(),
    attempts,
    seq: attempts + 1,
  };
}

/** Builds a minimal `OutboxEntry` for order tests. `seq` omitted (not just
 * `undefined`) simulates a pre-#1145 legacy entry that never had the field at all
 * (see `compareOutboxOrder`'s doc comment in outbox.ts). */
function orderEntry(opts: { id: string; createdAt: string; seq?: number }): OutboxEntry {
  const base = {
    id: opts.id,
    table: 'tasks' as const,
    rowId: 'r1',
    op: 'upsert' as const,
    payload: {},
    updatedAt: opts.createdAt,
    baseSeq: null,
    createdAt: opts.createdAt,
    attempts: 0,
  };
  return (opts.seq === undefined ? base : { ...base, seq: opts.seq }) as OutboxEntry;
}

describe('overSyncErrorThreshold', () => {
  it('is false for an empty queue', () => {
    expect(overSyncErrorThreshold([])).toBe(false);
  });

  it('is false when every entry is below the threshold', () => {
    expect(overSyncErrorThreshold([entry(SYNC_ERROR_THRESHOLD - 1)])).toBe(false);
  });

  it('is true once an entry reaches the threshold', () => {
    expect(overSyncErrorThreshold([entry(SYNC_ERROR_THRESHOLD)])).toBe(true);
  });

  it('is true if any entry in a mixed queue is over the threshold', () => {
    expect(overSyncErrorThreshold([entry(0), entry(SYNC_ERROR_THRESHOLD + 3)])).toBe(true);
  });
});

describe('mutate on a read-only table (ADR-0011)', () => {
  it('throws before ever touching IndexedDB', async () => {
    // Mirrors the server-side rejection in push/route.ts — the client should see
    // this at build time, not after a round trip that gets rejected anyway.
    await expect(mutate({ table: 'garmin_activities', op: 'upsert', payload: {} })).rejects.toThrow(
      /read-only/,
    );
  });
});

describe('nextOutboxSeq (#1145)', () => {
  it('starts at 1 for an empty outbox', () => {
    expect(nextOutboxSeq(undefined)).toBe(1);
  });

  it('is monotonic given the current maximum', () => {
    expect(nextOutboxSeq(1)).toBe(2);
    expect(nextOutboxSeq(41)).toBe(42);
  });
});

describe('compareOutboxOrder / sortByOrder (#1145)', () => {
  it('orders seq-carrying entries by seq, independent of createdAt', () => {
    // "Later" createdAt, but written first — the exact clock-correction-across-a-
    // reload scenario this ticket fixes: the earlier mutation still has the
    // smaller seq.
    const first = orderEntry({ id: 'a', createdAt: '2026-01-01T01:00:00.000Z', seq: 1 });
    const second = orderEntry({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z', seq: 2 });

    expect(sortByOrder([second, first])).toEqual([first, second]);
  });

  it('falls back to createdAt then id for entries without a numeric seq', () => {
    const older = orderEntry({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = orderEntry({ id: 'a', createdAt: '2026-01-01T01:00:00.000Z' });

    expect(sortByOrder([newer, older])).toEqual([older, newer]);
  });

  it('breaks a tie on identical createdAt by id', () => {
    const a = orderEntry({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
    const b = orderEntry({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' });

    expect(sortByOrder([b, a])).toEqual([a, b]);
  });

  it('sorts every seq-less entry ahead of every seq-carrying entry', () => {
    const legacy = orderEntry({ id: 'legacy', createdAt: '2026-01-01T02:00:00.000Z' });
    const migrated = orderEntry({ id: 'migrated', createdAt: '2026-01-01T00:00:00.000Z', seq: 1 });

    expect(compareOutboxOrder(legacy, migrated)).toBeLessThan(0);
    expect(compareOutboxOrder(migrated, legacy)).toBeGreaterThan(0);
  });
});
