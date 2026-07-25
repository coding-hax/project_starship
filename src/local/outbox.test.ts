import { describe, expect, it } from 'vitest';
import { overSyncErrorThreshold, SYNC_ERROR_THRESHOLD } from './outbox';
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
  };
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
