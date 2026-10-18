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

const ensureAccountCheckedMock = vi.fn();
const markBlockedMock = vi.fn();
const wipeLocalDatabaseMock = vi.fn();
// sync.ts calls `registerUnauthenticatedHook()` at its own module-load time (not
// inside a function body like the mocks above), which runs as soon as the static
// `import ... from './sync'` below is evaluated — before this file's own `const`
// statements would otherwise run. `vi.hoisted` is the one way to guarantee this
// particular mock exists before that happens, not just before `vi.mock` is reached.
const registerUnauthenticatedHookMock = vi.hoisted(() => vi.fn());

vi.mock('./account-isolation', () => ({
  ensureAccountChecked: () => ensureAccountCheckedMock(),
  markBlocked: () => markBlockedMock(),
  wipeLocalDatabase: () => wipeLocalDatabaseMock(),
  registerUnauthenticatedHook: (fn: () => void) => registerUnauthenticatedHookMock(fn),
}));

import { cursorAfterSkips } from './conflict';
import { pull, push, setUnauthorizedHandler, sync } from './sync';

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
    seq: 1,
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
  ensureAccountCheckedMock.mockReset().mockResolvedValue('ready');
  markBlockedMock.mockReset();
  wipeLocalDatabaseMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('unauthenticated hook registration (S2, #1201)', () => {
  it('forwards to the unauthorized handler so a stale cookie caught by ensureAccountChecked itself still redirects', () => {
    expect(registerUnauthenticatedHookMock).toHaveBeenCalledTimes(1);
    const registeredHook = registerUnauthenticatedHookMock.mock.calls[0][0] as () => void;
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    registeredHook();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no handler is registered yet', () => {
    const registeredHook = registerUnauthenticatedHookMock.mock.calls[0][0] as () => void;

    expect(() => registeredHook()).not.toThrow();
  });
});

describe('pull', () => {
  it('advances the cursor and writes the row after a pull', async () => {
    const change = changeRow({ syncSeq: 5 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [change], cursor: 5 }))),
    );

    const result = await pull();

    expect(result).toEqual({ appliedAny: true, complete: true });
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

    expect(result).toEqual({ appliedAny: true, complete: true });
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

    expect(result).toEqual({ appliedAny: true, complete: true });
    expect(recordsPutMock).not.toHaveBeenCalled();
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 5);
  });

  it('stays offline-safe: a network failure leaves the cursor untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await pull();

    expect(result).toEqual({ appliedAny: false, complete: false });
    expect(setMetaMock).not.toHaveBeenCalled();
    expect(recordsPutMock).not.toHaveBeenCalled();
  });

  it('stops without advancing the cursor when the server answers non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const result = await pull();

    expect(result).toEqual({ appliedAny: false, complete: false });
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('wipes the local database and calls the unauthorized handler on a 401, without touching the cursor (AK6)', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    const result = await pull();

    expect(result).toEqual({ appliedAny: false, complete: false });
    expect(wipeLocalDatabaseMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('does nothing special on a 401 when no handler is registered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    await expect(pull()).resolves.toEqual({ appliedAny: false, complete: false });
  });

  it('marks the account blocked and stops on a 403, without wiping or touching the cursor (AK5)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 403)));

    const result = await pull();

    expect(result).toEqual({ appliedAny: false, complete: false });
    expect(markBlockedMock).toHaveBeenCalledTimes(1);
    expect(wipeLocalDatabaseMock).not.toHaveBeenCalled();
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('never fetches when the account check is not ready', async () => {
    ensureAccountCheckedMock.mockResolvedValue('blocked');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await pull();

    expect(result).toEqual({ appliedAny: false, complete: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** `since` grows across pages like production does (read from `getMeta`, written via
   *  `setMeta`) — a statically-stubbed `since` cannot tell "page 2 was requested" apart
   *  from "the loop re-fetched page 1". */
  function statefulCursor(): void {
    let since = 0;
    getMetaMock.mockReset().mockImplementation(() => Promise.resolve(since));
    setMetaMock.mockReset().mockImplementation((_key: string, value: number) => {
      since = value;
      return Promise.resolve();
    });
  }

  it('keeps the cursor progress and reports incomplete when page 2 fails over the network (AK3)', async () => {
    statefulCursor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(pullResponse({ changes: [changeRow({ syncSeq: 5 })], cursor: 5, hasMore: true })),
      )
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pull();

    expect(result).toEqual({ appliedAny: true, complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setMetaMock).toHaveBeenCalledTimes(1);
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 5);
  });

  it('keeps the cursor progress and reports incomplete when page 2 answers HTTP 500 (AK3)', async () => {
    statefulCursor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(pullResponse({ changes: [changeRow({ syncSeq: 5 })], cursor: 5, hasMore: true })),
      )
      .mockResolvedValueOnce(jsonResponse({}, false, 500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pull();

    expect(result).toEqual({ appliedAny: true, complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setMetaMock).toHaveBeenCalledTimes(1);
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 5);
  });

  it('reports complete once a later page reports hasMore: false (AK1)', async () => {
    statefulCursor();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(pullResponse({ changes: [changeRow({ syncSeq: 5 })], cursor: 5, hasMore: true })),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          pullResponse({ changes: [changeRow({ id: 't2', syncSeq: 10 })], cursor: 10, hasMore: false }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await pull();

    expect(result).toEqual({ appliedAny: true, complete: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports complete for an account with no changes at all — completion never requires a row to land (AK5)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [], cursor: 0, hasMore: false }))),
    );

    const result = await pull();

    expect(result).toEqual({ appliedAny: true, complete: true });
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

  it('wipes the local database and calls the unauthorized handler on a 401 instead of marking the queue failed (AK6)', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 401)));

    await push();

    expect(wipeLocalDatabaseMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it('marks the account blocked on a 403 instead of marking the queue failed (AK5)', async () => {
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 403)));

    await push();

    expect(markBlockedMock).toHaveBeenCalledTimes(1);
    expect(wipeLocalDatabaseMock).not.toHaveBeenCalled();
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

describe('sync', () => {
  it('neither pushes nor pulls when the account check is not ready (#1201)', async () => {
    ensureAccountCheckedMock.mockResolvedValue('blocked');
    pendingMock.mockResolvedValue([outboxEntry({ id: 'm1' })]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await sync();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushes and pulls once the account check is ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(pullResponse({ changes: [], cursor: 0, hasMore: false }))),
    );

    await sync();

    expect(ensureAccountCheckedMock).toHaveBeenCalled();
    expect(setMetaMock).toHaveBeenCalledWith('lastPulledSeq', 0);
  });
});
