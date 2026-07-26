import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredRow {
  token: unknown;
  expiresAt: Date | null;
}

const dbState: { oauth1?: StoredRow; oauth2?: StoredRow } = {};
let selectCallCount = 0;

const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
const insertMock = vi.fn(() => ({ values: valuesMock }));

vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            // ensureAccessToken always reads oauth1 first, then (conditionally) oauth2.
            selectCallCount += 1;
            const row = selectCallCount === 1 ? dbState.oauth1 : dbState.oauth2;
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
    insert: insertMock,
  },
}));

const exchangeMock = vi.fn();
vi.mock('./connect-api', () => ({
  exchangeOAuth1ForOAuth2: (...args: unknown[]) => exchangeMock(...args),
}));

// Dynamic, not static: a static `import './tokens'` would resolve — and, through
// it, evaluate the '@/db' mock factory above — before the `const`s in this file
// (dbState, insertMock, …) have run, throwing "Cannot access before initialization".
async function loadTokens() {
  return import('./tokens');
}

describe('ensureAccessToken', () => {
  beforeEach(() => {
    selectCallCount = 0;
    dbState.oauth1 = undefined;
    dbState.oauth2 = undefined;
    onConflictDoUpdateMock.mockClear();
    valuesMock.mockClear();
    insertMock.mockClear();
    exchangeMock.mockReset();
  });

  it('throws GarminBootstrapRequired when no OAuth1 token is stored', async () => {
    const { ensureAccessToken, GarminBootstrapRequired } = await loadTokens();
    await expect(ensureAccessToken()).rejects.toBeInstanceOf(GarminBootstrapRequired);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('throws GarminBootstrapRequired when OAuth1 is expired — never retries, never logs in', async () => {
    const { ensureAccessToken, GarminBootstrapRequired } = await loadTokens();
    dbState.oauth1 = {
      token: { token: 't', tokenSecret: 's' },
      expiresAt: new Date(Date.now() - 1000),
    };

    await expect(ensureAccessToken()).rejects.toBeInstanceOf(GarminBootstrapRequired);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('reuses a still-valid stored OAuth2 token without calling Garmin', async () => {
    const { ensureAccessToken } = await loadTokens();
    dbState.oauth1 = { token: { token: 't', tokenSecret: 's' }, expiresAt: null };
    dbState.oauth2 = {
      token: { accessToken: 'cached-token', refreshToken: 'r' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };

    const accessToken = await ensureAccessToken();

    expect(accessToken).toBe('cached-token');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refreshes from OAuth1 and persists the new OAuth2 token when none is stored', async () => {
    const { ensureAccessToken } = await loadTokens();
    dbState.oauth1 = { token: { token: 't', tokenSecret: 's' }, expiresAt: null };
    dbState.oauth2 = undefined;
    exchangeMock.mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh',
      expiresInSeconds: 3600,
    });

    const accessToken = await ensureAccessToken();

    expect(accessToken).toBe('fresh-token');
    expect(exchangeMock).toHaveBeenCalledWith({ token: 't', tokenSecret: 's' });
    expect(insertMock).toHaveBeenCalledWith(expect.anything());
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'oauth2',
        token: { accessToken: 'fresh-token', refreshToken: 'fresh-refresh' },
      }),
    );
    expect(onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the stored OAuth2 token is close to expiry, not just when absent', async () => {
    const { ensureAccessToken } = await loadTokens();
    dbState.oauth1 = { token: { token: 't', tokenSecret: 's' }, expiresAt: null };
    dbState.oauth2 = {
      token: { accessToken: 'stale-token', refreshToken: 'r' },
      // Inside the 5-minute refresh margin.
      expiresAt: new Date(Date.now() + 60 * 1000),
    };
    exchangeMock.mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'fresh-refresh',
      expiresInSeconds: 3600,
    });

    const accessToken = await ensureAccessToken();

    expect(accessToken).toBe('fresh-token');
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });
});
