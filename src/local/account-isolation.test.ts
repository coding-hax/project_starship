import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMetaMock = vi.fn();
const setMetaMock = vi.fn();
const clearMocks = {
  records: vi.fn(),
  outbox: vi.fn(),
  meta: vi.fn(),
  weather: vi.fn(),
  journalSession: vi.fn(),
  journalKeyStash: vi.fn(),
  icsSubscriptions: vi.fn(),
};

vi.mock('./dexie', () => ({
  db: {
    transaction: (...args: unknown[]) => (args[args.length - 1] as () => Promise<unknown>)(),
    records: { clear: () => clearMocks.records() },
    outbox: { clear: () => clearMocks.outbox() },
    meta: { clear: () => clearMocks.meta() },
    weather: { clear: () => clearMocks.weather() },
    journalSession: { clear: () => clearMocks.journalSession() },
    journalKeyStash: { clear: () => clearMocks.journalKeyStash() },
    icsSubscriptions: { clear: () => clearMocks.icsSubscriptions() },
  },
  getMeta: (key: string) => getMetaMock(key),
  setMeta: (key: string, value: unknown) => setMetaMock(key, value),
}));

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  getMetaMock.mockReset().mockResolvedValue(undefined);
  setMetaMock.mockReset();
  for (const mock of Object.values(clearMocks)) mock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ensureAccountChecked', () => {
  it('wipes and marks unauthenticated when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })));
    const { ensureAccountChecked } = await import('./account-isolation');

    const result = await ensureAccountChecked();

    expect(result).toBe('unauthenticated');
    expect(clearMocks.records).toHaveBeenCalled();
    expect(clearMocks.journalSession).toHaveBeenCalled();
    expect(setMetaMock).not.toHaveBeenCalled();
  });

  it('marks blocked without wiping anything', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, userId: 'a', blocked: true })),
    );
    const { ensureAccountChecked, isBlocked } = await import('./account-isolation');

    const result = await ensureAccountChecked();

    expect(result).toBe('blocked');
    expect(isBlocked()).toBe(true);
    expect(clearMocks.records).not.toHaveBeenCalled();
  });

  it('is ready without wiping when the stored marker matches the session account', async () => {
    getMetaMock.mockResolvedValue('a');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, userId: 'a', blocked: false })),
    );
    const { ensureAccountChecked } = await import('./account-isolation');

    const result = await ensureAccountChecked();

    expect(result).toBe('ready');
    expect(clearMocks.records).not.toHaveBeenCalled();
  });

  it('wipes and stamps the new marker when the session account differs from the stored one', async () => {
    getMetaMock.mockResolvedValue('a');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, userId: 'b', blocked: false })),
    );
    const { ensureAccountChecked } = await import('./account-isolation');

    const result = await ensureAccountChecked();

    expect(result).toBe('ready');
    expect(clearMocks.records).toHaveBeenCalled();
    expect(clearMocks.journalKeyStash).toHaveBeenCalled();
    expect(setMetaMock).toHaveBeenCalledWith('accountId', 'b');
  });

  it('reports offline on a network failure, uncached', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, userId: 'a', blocked: false }));
    vi.stubGlobal('fetch', fetchMock);
    getMetaMock.mockResolvedValue('a');
    const { ensureAccountChecked } = await import('./account-isolation');

    expect(await ensureAccountChecked()).toBe('offline');
    expect(await ensureAccountChecked()).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a terminal result so a second call never fetches again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ authenticated: true, userId: 'a', blocked: false }));
    vi.stubGlobal('fetch', fetchMock);
    getMetaMock.mockResolvedValue('a');
    const { ensureAccountChecked } = await import('./account-isolation');

    expect(await ensureAccountChecked()).toBe('ready');
    expect(await ensureAccountChecked()).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping callers onto the same in-flight check', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    getMetaMock.mockResolvedValue('a');
    const { ensureAccountChecked } = await import('./account-isolation');

    const first = ensureAccountChecked();
    const second = ensureAccountChecked();
    resolveFetch(jsonResponse({ authenticated: true, userId: 'a', blocked: false }));

    expect(await first).toBe('ready');
    expect(await second).toBe('ready');
  });
});

describe('unauthenticated hook', () => {
  it('runs every registered hook when the session turns out to be gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ authenticated: false })));
    const { ensureAccountChecked, registerUnauthenticatedHook } = await import('./account-isolation');
    const hook = vi.fn();
    registerUnauthenticatedHook(hook);

    await ensureAccountChecked();

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not run when the account merely switches to a different valid one', async () => {
    getMetaMock.mockResolvedValue('a');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, userId: 'b', blocked: false })),
    );
    const { ensureAccountChecked, registerUnauthenticatedHook } = await import('./account-isolation');
    const hook = vi.fn();
    registerUnauthenticatedHook(hook);

    await ensureAccountChecked();

    expect(hook).not.toHaveBeenCalled();
  });
});

describe('markBlocked', () => {
  it('flips the blocked store and is observable without a fetch', async () => {
    const { markBlocked, isBlocked, subscribeBlocked, ensureAccountChecked } = await import(
      './account-isolation'
    );
    const listener = vi.fn();
    subscribeBlocked(listener);

    markBlocked();

    expect(isBlocked()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await ensureAccountChecked()).toBe('blocked');
  });
});

describe('wipeLocalDatabase', () => {
  it('clears every store and runs every registered wipe hook', async () => {
    const { wipeLocalDatabase, registerWipeHook } = await import('./account-isolation');
    const hook = vi.fn();
    registerWipeHook(hook);

    await wipeLocalDatabase();

    for (const mock of Object.values(clearMocks)) expect(mock).toHaveBeenCalled();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(setMetaMock).not.toHaveBeenCalled();
  });
});

describe('resetAccountCheck', () => {
  it('drops the cached result and the blocked flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, userId: 'a', blocked: true })),
    );
    const { ensureAccountChecked, isBlocked, resetAccountCheck } = await import(
      './account-isolation'
    );

    await ensureAccountChecked();
    expect(isBlocked()).toBe(true);

    resetAccountCheck();

    expect(isBlocked()).toBe(false);
  });
});
