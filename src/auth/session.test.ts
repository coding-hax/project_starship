import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

const limit = vi.fn();
const updateWhere = vi.fn().mockResolvedValue(undefined);
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }), where: () => ({ limit }) }) }),
    update: () => ({ set: () => ({ where: updateWhere }) }),
  },
}));

/**
 * The gate itself (issue #176, re-cut for multi-user in #1200). What changed:
 * the identity comes out of the joined `sessions`/`users` row, not out of an
 * environment variable — and a blocked account is a *different* answer than no
 * session at all, because the client must distinguish them (ADR-0031).
 */
describe('requireUser', () => {
  const USER_ID = 'user-uuid';
  const live = (over: Record<string, unknown> = {}) => ({
    userId: USER_ID,
    role: 'user',
    credentialId: 'cred-uuid',
    blockedAt: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws UnauthorizedError when no session cookie is set (401)', async () => {
    cookieStore.get.mockReturnValue(undefined);

    const { requireUser, UnauthorizedError } = await import('./session');
    await expect(requireUser()).rejects.toThrow(UnauthorizedError);
  });

  it('throws UnauthorizedError when the session token matches no live row (401)', async () => {
    cookieStore.get.mockReturnValue({ value: 'stale-token' });
    limit.mockResolvedValue([]);

    const { requireUser, UnauthorizedError } = await import('./session');
    await expect(requireUser()).rejects.toThrow(UnauthorizedError);
  });

  it('resolves to the account from the session row, not from the environment', async () => {
    cookieStore.get.mockReturnValue({ value: 'valid-token' });
    limit.mockResolvedValue([live()]);

    const { requireUser } = await import('./session');
    await expect(requireUser()).resolves.toMatchObject({
      userId: USER_ID,
      role: 'user',
      credentialId: 'cred-uuid',
    });
  });

  it('carries the role through, so /admin can gate on it without a second query', async () => {
    cookieStore.get.mockReturnValue({ value: 'valid-token' });
    limit.mockResolvedValue([live({ role: 'admin' })]);

    const { requireUser } = await import('./session');
    await expect(requireUser()).resolves.toMatchObject({ role: 'admin' });
  });

  it('throws AccountBlockedError — not UnauthorizedError — for a locked account (403)', async () => {
    cookieStore.get.mockReturnValue({ value: 'valid-token' });
    limit.mockResolvedValue([live({ blockedAt: new Date('2026-10-17T00:00:00Z') })]);

    const { requireUser, AccountBlockedError, UnauthorizedError } = await import('./session');
    await expect(requireUser()).rejects.toThrow(AccountBlockedError);
    await expect(requireUser()).rejects.not.toThrow(UnauthorizedError);
  });

  it('getSession still resolves a blocked account — the lock is a decision, not an identity gap', async () => {
    cookieStore.get.mockReturnValue({ value: 'valid-token' });
    const blockedAt = new Date('2026-10-17T00:00:00Z');
    limit.mockResolvedValue([live({ blockedAt })]);

    const { getSession } = await import('./session');
    await expect(getSession()).resolves.toMatchObject({ userId: USER_ID, blockedAt });
  });
});
