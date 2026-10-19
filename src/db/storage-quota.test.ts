import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, limitMock, selectMock } = vi.hoisted(() => {
  const executeMock = vi.fn();
  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  return { executeMock, limitMock, selectMock };
});

vi.mock('@/db', () => ({
  db: {
    execute: executeMock,
    select: selectMock,
  },
}));

import {
  accountStorageBytes,
  DEFAULT_STORAGE_LIMIT_BYTES,
  effectiveLimit,
  isOverLimit,
} from './storage-quota';

beforeEach(() => {
  executeMock.mockReset();
  limitMock.mockReset();
});

describe('effectiveLimit (#1205 AC6)', () => {
  it('falls back to the code default when the account has no override', () => {
    expect(effectiveLimit({ storageLimitBytes: null })).toBe(DEFAULT_STORAGE_LIMIT_BYTES);
  });

  it('uses the account override when one is set, even a smaller one', () => {
    expect(effectiveLimit({ storageLimitBytes: 1024 })).toBe(1024);
  });
});

describe('accountStorageBytes', () => {
  it('reads the summed bytes straight off the single aggregate query', async () => {
    executeMock.mockResolvedValue({ rows: [{ bytes: '4096' }] });

    expect(await accountStorageBytes('user-a')).toBe(4096);
  });

  it('treats no row as zero bytes', async () => {
    executeMock.mockResolvedValue({ rows: [] });

    expect(await accountStorageBytes('user-a')).toBe(0);
  });
});

describe('isOverLimit', () => {
  it('is false for an account under its limit', async () => {
    limitMock.mockResolvedValue([{ storageLimitBytes: null }]);
    executeMock.mockResolvedValue({ rows: [{ bytes: '100' }] });

    expect(await isOverLimit('user-a')).toBe(false);
  });

  it('is true once usage exceeds the account override', async () => {
    limitMock.mockResolvedValue([{ storageLimitBytes: 50 }]);
    executeMock.mockResolvedValue({ rows: [{ bytes: '51' }] });

    expect(await isOverLimit('user-a')).toBe(true);
  });

  it('is false for an account that no longer exists — nothing to measure, nothing to block', async () => {
    limitMock.mockResolvedValue([]);

    expect(await isOverLimit('user-missing')).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });

  /**
   * Fail-open, same stance as `enforce()` in src/auth/rate-limit.ts — a broken
   * measurement must never turn into a write being blocked.
   */
  it('fails open when the measurement itself throws', async () => {
    limitMock.mockRejectedValue(new Error('db unreachable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await isOverLimit('user-a')).toBe(false);

    consoleError.mockRestore();
  });
});
