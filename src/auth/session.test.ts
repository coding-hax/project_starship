import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));

const limit = vi.fn();
vi.mock('@/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) },
}));

describe('requireOwner (issue #176)', () => {
  const OWNER_ID = 'owner-uuid';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_USER_ID = OWNER_ID;
  });

  it('throws UnauthorizedError when no session cookie is set (AC1: 401)', async () => {
    cookieStore.get.mockReturnValue(undefined);

    const { requireOwner, UnauthorizedError } = await import('./session');
    await expect(requireOwner()).rejects.toThrow(UnauthorizedError);
  });

  it('throws UnauthorizedError when the session token matches no live row (AC1: 401)', async () => {
    cookieStore.get.mockReturnValue({ value: 'stale-token' });
    limit.mockResolvedValue([]);

    const { requireOwner, UnauthorizedError } = await import('./session');
    await expect(requireOwner()).rejects.toThrow(UnauthorizedError);
  });

  it('resolves to the owner id for a valid session — unchanged behaviour (AC2)', async () => {
    cookieStore.get.mockReturnValue({ value: 'valid-token' });
    limit.mockResolvedValue([
      { id: 'session-uuid', tokenHash: 'hash', expiresAt: new Date(Date.now() + 1000) },
    ]);

    const { requireOwner } = await import('./session');
    await expect(requireOwner()).resolves.toBe(OWNER_ID);
  });
});
