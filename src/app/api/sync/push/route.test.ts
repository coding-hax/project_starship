import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from '@/local/types';

const SESSION_USER = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  role: 'user' as const,
  sessionId: 'session-1',
  credentialId: 'cred-1',
  deviceId: null,
  lastSeenAt: null,
  blockedAt: null,
  appVersion: null,
};
const recordSessionVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/auth/session', () => ({
  requireUser: vi.fn().mockResolvedValue(SESSION_USER),
  recordSessionVersion: recordSessionVersionMock,
  UnauthorizedError: class UnauthorizedError extends Error {},
  AccountBlockedError: class AccountBlockedError extends Error {},
}));

const recordSyncCountersMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/db/sync-counters', () => ({ recordSyncCounters: recordSyncCountersMock }));

const insertValues = vi.fn().mockResolvedValue(undefined);
const updateWhere = vi.fn().mockResolvedValue(undefined);
const selectLimit = vi.fn().mockResolvedValue([]);

const tx = {
  execute: vi.fn().mockResolvedValue(undefined),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: selectLimit,
      }),
    }),
  }),
  insert: () => ({ values: insertValues }),
  update: () => ({ set: () => ({ where: updateWhere }) }),
  transaction: (fn: (sp: unknown) => Promise<void>) => fn(tx),
};

vi.mock('@/db', () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<void>) => fn(tx),
  },
}));

const isOverLimitMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('@/db/storage-quota', () => ({ isOverLimit: isOverLimitMock }));

function makeRequest(mutations: unknown): Request {
  return new Request('http://localhost/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ mutations }),
  });
}

function validMutation(id: string): Mutation {
  return {
    id,
    table: 'tasks',
    rowId: `row-${id}`,
    op: 'upsert',
    payload: { title: 'x' },
    updatedAt: new Date().toISOString(),
    baseSeq: null,
  };
}

describe('POST /api/sync/push', () => {
  beforeEach(() => {
    insertValues.mockClear();
    updateWhere.mockClear();
    selectLimit.mockReset().mockResolvedValue([]);
    isOverLimitMock.mockReset().mockResolvedValue(false);
    recordSyncCountersMock.mockReset().mockResolvedValue(undefined);
    recordSessionVersionMock.mockReset().mockResolvedValue(undefined);
  });

  it('applies the valid mutations and rejects the malformed one individually', async () => {
    const { POST } = await import('./route');
    const malformed = {
      id: 'bad',
      table: 'tasks',
      rowId: 123,
      op: 'upsert',
      payload: {},
      updatedAt: new Date().toISOString(),
      baseSeq: null,
    };
    const mutations = [malformed, validMutation('a'), validMutation('b'), validMutation('c')];

    const response = await POST(makeRequest(mutations));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.applied.sort()).toEqual(['a', 'b', 'c']);
    expect(body.rejected).toEqual([{ mutationId: 'bad', reason: 'malformed', missing: ['rowId'] }]);
  });

  it('rejects the whole request with 400 only when mutations is not an array', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest('not-an-array'));
    expect(response.status).toBe(400);
  });

  it('rejects a mutation that violates a DB constraint without wedging the rest of the batch', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertValues.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    try {
      const { POST } = await import('./route');
      const poisoned = validMutation('poisoned');
      const mutations = [poisoned, validMutation('ok')];

      const response = await POST(makeRequest(mutations));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.applied).toEqual(['ok']);
      expect(body.rejected).toEqual([{ mutationId: 'poisoned', reason: 'constraint', missing: [] }]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('rejects a mutation on a table that is not in SYNC_TABLES without touching the DB (#1200)', async () => {
    const { POST } = await import('./route');
    // `garmin_activities` left SYNC_TABLES with the Garmin removal. An old client
    // still holding such an outbox entry must be turned away at the door, not
    // crash the batch it travelled with.
    const mutation = {
      id: 'garmin-1',
      table: 'garmin_activities',
      rowId: 'row-garmin-1',
      op: 'upsert',
      payload: { name: 'Fälschung' },
      updatedAt: new Date().toISOString(),
      baseSeq: null,
    } as unknown as Mutation;

    const response = await POST(makeRequest([mutation]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([
      { mutationId: 'garmin-1', reason: 'malformed', missing: ['table'] },
    ]);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it('upserts on the natural key (habitId, logDate) instead of inserting a colliding row (#475)', async () => {
    const { POST } = await import('./route');
    const existingRow = { id: 'row-existing', deletedAt: null, syncSeq: 3, updatedAt: new Date() };
    // First select (by id) finds nothing, second (by natural key) finds the row
    // another device already created for this (habitId, logDate).
    selectLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([existingRow]);

    const mutation: Mutation = {
      id: 'log-b',
      table: 'habit_logs',
      rowId: 'row-from-device-b',
      op: 'upsert',
      payload: { habitId: 'habit-1', logDate: '2026-08-04', done: false },
      updatedAt: new Date().toISOString(),
      baseSeq: null,
    };

    const response = await POST(makeRequest([mutation]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.applied).toEqual(['log-b']);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateWhere).toHaveBeenCalledWith(expect.anything());
  });

  describe('Speicher-Quote (#1205 AC6)', () => {
    it('lehnt eine Charge mit einer Nicht-delete-Mutation ab, wenn das Konto über dem Limit liegt', async () => {
      isOverLimitMock.mockResolvedValue(true);
      const { POST } = await import('./route');

      const response = await POST(makeRequest([validMutation('a')]));
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(typeof body.error).toBe('string');
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('lässt eine Charge aus ausschließlich delete durch, auch über dem Limit', async () => {
      isOverLimitMock.mockResolvedValue(true);
      const { POST } = await import('./route');
      const deleteOnly: Mutation = { ...validMutation('a'), op: 'delete', payload: {} };

      const response = await POST(makeRequest([deleteOnly]));

      expect(response.status).toBe(200);
    });

    it('fragt die Quote gar nicht erst ab, wenn das Konto unter dem Limit liegt', async () => {
      const { POST } = await import('./route');

      const response = await POST(makeRequest([validMutation('a')]));

      expect(response.status).toBe(200);
      expect(isOverLimitMock).toHaveBeenCalledWith(SESSION_USER.userId);
    });
  });

  describe('Sync-Zähler (#1235 AK6)', () => {
    it('antwortet normal, selbst wenn recordSyncCounters wirft', async () => {
      recordSyncCountersMock.mockRejectedValue(new Error('counter db down'));
      const { POST } = await import('./route');

      const response = await POST(makeRequest([validMutation('a')]));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ applied: ['a'], conflicts: [], rejected: [] });
    });

    it('antwortet normal mit 413, selbst wenn recordSyncCounters im Quote-Zweig wirft', async () => {
      isOverLimitMock.mockResolvedValue(true);
      recordSyncCountersMock.mockRejectedValue(new Error('counter db down'));
      const { POST } = await import('./route');

      const response = await POST(makeRequest([validMutation('a')]));

      expect(response.status).toBe(413);
    });
  });
});
