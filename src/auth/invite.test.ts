import { describe, expect, it, vi } from 'vitest';
import { createInvite, verifyInvite } from './invite';

const insert = vi.fn();
const limit = vi.fn();
vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: insert }),
    select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
  },
}));

/**
 * #1224 AK9: an invite token must come from a cryptographic random source with
 * at least 128 bits of entropy, and the database/API must never hand the
 * plaintext back out a second time.
 */
describe('createInvite', () => {
  it('erzeugt ein base64url-Token aus mindestens 128 Bit Zufall', async () => {
    insert.mockResolvedValue(undefined);
    const { token } = await createInvite({ createdBy: 'admin-1' });

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url encodes 6 bits/char; >=128 bits needs ceil(128/6) = 22 chars.
    expect(token.length).toBeGreaterThanOrEqual(22);
  });
});

describe('verifyInvite', () => {
  it('gibt nie das Token selbst zurück, nur id/userId', async () => {
    limit.mockResolvedValue([{ id: 'invite-1', userId: 'user-1' }]);
    const result = await verifyInvite('irrelevant-token');

    expect(result).toEqual({ id: 'invite-1', userId: 'user-1' });
    expect(Object.keys(result ?? {})).not.toContain('token');
  });
});
