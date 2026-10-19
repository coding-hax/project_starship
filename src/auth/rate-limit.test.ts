import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory stand-in for the `(bucket, key, window_start)` upsert `enforce()`
 * runs against Postgres (`onConflictDoUpdate`, see rate-limit.ts) — same shape
 * as `push/reminders/index.test.ts`'s `insertValuesMock`, just keyed by three
 * columns instead of four.
 */
let rows: Array<{ bucket: string; key: string; windowStart: string; count: number }> = [];

vi.mock('@/db', () => ({
  db: {
    delete: () => ({ where: () => Promise.resolve() }),
    insert: () => ({
      values: (row: { bucket: string; key: string; windowStart: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const windowStart = row.windowStart.toISOString();
            const existing = rows.find(
              (r) => r.bucket === row.bucket && r.key === row.key && r.windowStart === windowStart,
            );
            if (existing) {
              existing.count += 1;
              return Promise.resolve([{ count: existing.count }]);
            }
            rows.push({ bucket: row.bucket, key: row.key, windowStart, count: 1 });
            return Promise.resolve([{ count: 1 }]);
          },
        }),
      }),
    }),
  },
}));

import { AUTH_RATE_LIMITS, enforce } from './rate-limit';

function icsRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/ics', { headers });
}

beforeEach(() => {
  rows = [];
});

describe('enforce — ics bucket keyed by account (#1205 AC5)', () => {
  it('keeps two accounts behind the same IP on independent budgets', async () => {
    const request = icsRequest({ 'x-real-ip': '203.0.113.5' });
    for (let i = 0; i < AUTH_RATE_LIMITS.ics.limit; i++) {
      expect(await enforce(request, 'ics', 'user-a')).toBeNull();
    }
    expect((await enforce(request, 'ics', 'user-a'))?.status).toBe(429);

    // Same IP, different account — user-a's exhausted budget never touched this one.
    expect(await enforce(request, 'ics', 'user-b')).toBeNull();
  });

  it('falls back to clientKey(request) when no explicit key is passed', async () => {
    const requestA = icsRequest({ 'x-real-ip': '203.0.113.9' });
    const requestB = icsRequest({ 'x-real-ip': '203.0.113.10' });
    for (let i = 0; i < AUTH_RATE_LIMITS.ics.limit; i++) {
      await enforce(requestA, 'ics');
    }
    expect((await enforce(requestA, 'ics'))?.status).toBe(429);
    expect(await enforce(requestB, 'ics')).toBeNull();
  });
});
