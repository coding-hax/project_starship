import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mutation } from '@/local/types';

vi.mock('@/auth/session', () => ({
  requireOwner: vi.fn().mockResolvedValue('owner-id'),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const insertValues = vi.fn().mockResolvedValue(undefined);
const updateWhere = vi.fn().mockResolvedValue(undefined);

const tx = {
  execute: vi.fn().mockResolvedValue(undefined),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
      }),
    }),
  }),
  insert: () => ({ values: insertValues }),
  update: () => ({ set: () => ({ where: updateWhere }) }),
};

vi.mock('@/db', () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<void>) => fn(tx),
  },
}));

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

  it('rejects a mutation on a read-only table (ADR-0011) without touching the DB', async () => {
    const { POST } = await import('./route');
    const mutation: Mutation = {
      id: 'garmin-1',
      table: 'garmin_activities',
      rowId: 'row-garmin-1',
      op: 'upsert',
      payload: { name: 'Fälschung' },
      updatedAt: new Date().toISOString(),
      baseSeq: null,
    };

    const response = await POST(makeRequest([mutation]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.applied).toEqual([]);
    expect(body.rejected).toEqual([{ mutationId: 'garmin-1', reason: 'read-only', missing: [] }]);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateWhere).not.toHaveBeenCalled();
  });
});
