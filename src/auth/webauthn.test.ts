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
const del = vi.fn();
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: select }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: update }) }) }),
    delete: () => ({ where: () => ({ returning: del }) }),
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

describe('consumeChallenge — single atomic DELETE … RETURNING', () => {
  it('resolves ok:true with the bound recoveryCodeId, without a prior SELECT', async () => {
    del.mockResolvedValue([{ recoveryCodeId: 'rc-1' }]);

    const { consumeChallenge } = await import('./webauthn');
    await expect(consumeChallenge('chal-1', 'registration')).resolves.toEqual({
      ok: true,
      recoveryCodeId: 'rc-1',
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('resolves ok:true with recoveryCodeId:null for an authentication challenge', async () => {
    del.mockResolvedValue([{ recoveryCodeId: null }]);

    const { consumeChallenge } = await import('./webauthn');
    await expect(consumeChallenge('chal-2', 'authentication')).resolves.toEqual({
      ok: true,
      recoveryCodeId: null,
    });
  });

  it('resolves ok:false when nothing matches — wrong kind, expired or unknown', async () => {
    del.mockResolvedValue([]);

    const { consumeChallenge } = await import('./webauthn');
    await expect(consumeChallenge('chal-3', 'registration')).resolves.toEqual({
      ok: false,
      recoveryCodeId: null,
    });
  });

  it('lets only the first of two concurrent consumers of the same challenge win', async () => {
    del.mockResolvedValueOnce([{ recoveryCodeId: 'rc-1' }]).mockResolvedValueOnce([]);

    const { consumeChallenge } = await import('./webauthn');
    await expect(consumeChallenge('chal-4', 'registration')).resolves.toEqual({
      ok: true,
      recoveryCodeId: 'rc-1',
    });
    await expect(consumeChallenge('chal-4', 'registration')).resolves.toEqual({
      ok: false,
      recoveryCodeId: null,
    });
  });
});
