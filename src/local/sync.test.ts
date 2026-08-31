import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeRow, OutboxEntry, PullResponse, PushResponse } from './types';

const pendingMock = vi.fn();
const markAppliedMock = vi.fn();
const markFailedMock = vi.fn();
const discardStaleMock = vi.fn();

vi.mock('./outbox', () => ({
  pending: () => pendingMock(),
  markApplied: (mutations: unknown) => markAppliedMock(mutations),
  markFailed: (ids: unknown, error: unknown, offline?: unknown) => markFailedMock(ids, error, offline),
  discardStale: (ids: unknown) => discardStaleMock(ids),
}));

const getMetaMock = vi.fn();
const setMetaMock = vi.fn();
const recordsGetMock = vi.fn();
const recordsPutMock = vi.fn();
const outboxToArrayMock = vi.fn();

vi.mock('./dexie', () => ({
  db: {
    // pull() uses the 4-arg form `transaction('rw', db.records, db.outbox, cb)` —
    // the callback is always the last argument, whatever else is passed.
    transaction: (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
    records: {
      get: (...args: unknown[]) => recordsGetMock(...args),
      put: (...args: unknown[]) => recordsPutMock(...args),
    },
    outbox: {
      toArray: () => outboxToArrayMock(),
    },
  },
  getMeta: (key: string) => getMetaMock(key),
  setMeta: (key: string, value: unknown) => setMetaMock(key, value),
  META_LAST_PULLED_SEQ: 'lastPulledSeq',
}));

import { cursorAfterSkips } from './conflict';
import { pull, push, setUnauthorizedHandler } from './sync';

function outboxEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'm1',
    table: 'tasks',
    rowId: 't1',
    op: 'upsert',
    payload: {},
    updatedAt: new Date().toISOString(),
    baseSeq: null,
    createdAt: new Date().toISOString(),
    attempts: 0,
    ...overrides,
  };
}

function changeRow(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    table: 'tasks',
    id: 't1',
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    syncSeq: 1,
    data: {},
    ...overrides,
  };
}

function pullResponse(overrides: Partial<PullResponse> = {}): PullResponse {
  return { changes: [], cursor: 0, hasMore: false, ...overrides };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  pendingMock.mockReset().mockResolvedValue([]);
  markAppliedMock.mockReset();
  markFailedMock.mockReset();
  discardStaleMock.mockReset();
  getMetaMock.mockReset().mockResolvedValue(0);
  setMetaMock.mockReset();
  recordsGetMock.mockReset().mockResolvedValue(undefined);
  recordsPutMock.mockReset();
  outboxToArrayMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('pull', () => {
  it('advances the cursor and writes the row after a pull', async () => {
    const change = changeRow({ syncSeq: 5 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [change], cursor: 5 }))),
    );

    const result = await pull();

    expect(result).toBe(true);
    expect(recordsPutMock).toHaveBeenCalledTimes(1);
    expect(recordsPutMock).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'tasks', id: 't1', syncSeq: 5 }),
    );
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 5);
  });

  it('skips a row that still has a mutation waiting in the outbox', async () => {
    outboxToArrayMock.mockResolvedValue([outboxEntry({ table: 'tasks', rowId: 't1' })]);
    const change = changeRow({ table: 'tasks', id: 't1', syncSeq: 5 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [change], cursor: 5 }))),
    );

    const result = await pull();

    expect(result).toBe(true);
    expect(recordsPutMock).not.toHaveBeenCalled();
    // The cursor still advances (clamped below the skip), it just never claims
    // the skipped row was applied — see cursorAfterSkips (issue #479).
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', cursorAfterSkips(5, [5]));
  });

  it('does not overwrite a local row already at or ahead of the incoming syncSeq', async () => {
    recordsGetMock.mockResolvedValue({
      table: 'tasks',
      id: 't1',
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      syncedAt: null,
      syncSeq: 5,
      data: {},
    });
    const change = changeRow({ table: 'tasks', id: 't1', syncSeq: 5 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [change], cursor: 5 }))),
    );

    const result = await pull();

    expect(result).toBe(true);
    expect(recordsPutMock).not.toHaveBeenCalled();
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 5);
  });

  it('stays offline-safe: a network failure leaves the cursor untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await pull();

    expect(result).toBe(false);
    expect(setMetaMock).not.toHaveBeenCalled();
    expect(recordsPutMock).not.toHaveBeenCalled();
  });

  it('stops without advancing the cursor when the server answers non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const result = await pull();

    expect(result).toBe(false);
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('calls the unauthorized handler and stops on a 401, without touching the cursor', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    const result = await pull();

    expect(result).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('does nothing special on a 401 when no handler is registered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    await expect(pull()).resolves.toBe(false);
  });

  it('bounds the fetch to a timeout so a request that never settles cannot wedge sync() forever (#954)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pullResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await pull();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('push', () => {
  it('never calls fetch when the outbox is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await push();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks the queue failed, without the offline flag, on a non-ok response', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 503)));

    await push();

    expect(markFailedMock).toHaveBeenCalledWith(['m1'], 'push failed: 503', undefined);
  });

  it('marks the queue failed with the offline flag when fetch throws', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await push();

    expect(markFailedMock).toHaveBeenCalledWith(['m1'], 'offline', true);
  });

  it('discards a rejected mutation instead of retrying it forever', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    const response: PushResponse = {
      applied: [],
      conflicts: [],
      rejected: [{ mutationId: 'm1', missing: [] }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));

    await push();

    expect(discardStaleMock).toHaveBeenCalledWith(['m1']);
  });

  it('marks an applied mutation done, including one the server flagged as a conflict', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    const response: PushResponse = {
      applied: ['m1'],
      conflicts: [
        {
          mutationId: 'm1',
          rowId: 't1',
          reason: 'overwritten',
          incomingUpdatedAt: new Date().toISOString(),
          overwrittenUpdatedAt: new Date().toISOString(),
        },
      ],
      rejected: [],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));

    await push();

    expect(markAppliedMock).toHaveBeenCalledWith([expect.objectContaining({ id: 'm1' })]);
    expect(discardStaleMock).not.toHaveBeenCalled();
  });

  it('calls the unauthorized handler on a 401 instead of marking the queue failed', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    await push();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it('bounds the fetch to a timeout so a request that never settles cannot wedge sync() forever (#954)', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    const response: PushResponse = { applied: ['m1'], conflicts: [], rejected: [] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await push();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
