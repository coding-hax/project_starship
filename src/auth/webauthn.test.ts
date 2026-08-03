import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #476: `redeemRecoveryCode` used to check and burn a recovery code in one
 * step. Splitting it into `verifyRecoveryCode` (check only, `usedAt` untouched)
 * and `burnRecoveryCode` (the single-use burn, conditioned on `isNull(usedAt)`)
 * is what lets `register/options` check without spending the code and
 * `register/verify` spend it only once the passkey ceremony actually succeeded.
 */

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const select = vi.fn();
const update = vi.fn();
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: select }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: update }) }) }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyRecoveryCode', () => {
  it('resolves to the matching row id without touching usedAt', async () => {
    const code = 'AAAA-BBBB-CCCC';
    select.mockResolvedValue([{ id: 'row-1', codeHash: hash(code), usedAt: null }]);

    const { verifyRecoveryCode } = await import('./webauthn');
    await expect(verifyRecoveryCode(code)).resolves.toBe('row-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('resolves to null when no unused code matches', async () => {
    select.mockResolvedValue([{ id: 'row-1', codeHash: hash('OTHER-CODE'), usedAt: null }]);

    const { verifyRecoveryCode } = await import('./webauthn');
    await expect(verifyRecoveryCode('AAAA-BBBB-CCCC')).resolves.toBeNull();
  });
});

describe('burnRecoveryCode (single-use via conditional update, not read-then-write)', () => {
  it('resolves to true when the conditional update affects exactly one row', async () => {
    update.mockResolvedValue([{ id: 'row-1' }]);

    const { burnRecoveryCode } = await import('./webauthn');
    await expect(burnRecoveryCode('row-1')).resolves.toBe(true);
  });

  it('resolves to false on a second burn — isNull(usedAt) already excludes the row', async () => {
    update.mockResolvedValue([]);

    const { burnRecoveryCode } = await import('./webauthn');
    await expect(burnRecoveryCode('row-1')).resolves.toBe(false);
  });
});
