import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireOwnerMock = vi.fn();
vi.mock('@/auth/session', () => ({
  requireOwner: (...args: unknown[]) => requireOwnerMock(...args),
}));

const syncActivitiesMock = vi.fn();
vi.mock('@/features/garmin/sync-activities', () => ({
  syncActivities: (...args: unknown[]) => syncActivitiesMock(...args),
}));

import { GarminBootstrapRequired } from '@/features/garmin/tokens';

const SECRET = 'top-secret-cron-value';

function makeRequest(
  headers: Record<string, string> = {},
  url = 'http://localhost/api/garmin-sync',
): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('POST /api/garmin-sync', () => {
  beforeEach(() => {
    vi.stubEnv('GARMIN_SYNC_SECRET', SECRET);
    requireOwnerMock.mockReset().mockRejectedValue(new Error('no session'));
    syncActivitiesMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers 503 when GARMIN_SYNC_SECRET is not set — never falls open', async () => {
    vi.stubEnv('GARMIN_SYNC_SECRET', '');
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(503);
    expect(syncActivitiesMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a bearer header and without an owner session', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
    expect(syncActivitiesMock).not.toHaveBeenCalled();
  });

  it('answers 401 with a wrong bearer token', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ authorization: 'Bearer wrong-value' }));
    expect(response.status).toBe(401);
    expect(syncActivitiesMock).not.toHaveBeenCalled();
  });

  it('answers 200 with the correct bearer token and returns the counters', async () => {
    syncActivitiesMock.mockResolvedValue({
      scanned: 3,
      created: 1,
      updated: 1,
      detailsFilled: 1,
      mapsFilled: 1,
    });
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ scanned: 3, created: 1, updated: 1, detailsFilled: 1, mapsFilled: 1 });
  });

  it('a valid owner session authorizes too — the manual kick from the app', async () => {
    requireOwnerMock.mockResolvedValue('owner-id');
    syncActivitiesMock.mockResolvedValue({
      scanned: 0,
      created: 0,
      updated: 0,
      detailsFilled: 0,
      mapsFilled: 0,
    });
    const { POST } = await import('./route');

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
  });

  it('answers 409 and writes nothing when OAuth1 is missing/expired', async () => {
    syncActivitiesMock.mockRejectedValue(
      new GarminBootstrapRequired('Kein OAuth1-Token hinterlegt.'),
    );
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(409);
    // syncActivities is the only writer; it rejected before ever opening the
    // write transaction, so "called once, rejected" already is "wrote nothing".
    expect(syncActivitiesMock).toHaveBeenCalledTimes(1);
  });

  it('answers 400 for a non-positive days value', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ authorization: `Bearer ${SECRET}` }, 'http://localhost/api/garmin-sync?days=0'),
    );
    expect(response.status).toBe(400);
    expect(syncActivitiesMock).not.toHaveBeenCalled();
  });

  it('never logs the bearer secret, a token, or a coordinate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    syncActivitiesMock.mockResolvedValue({
      scanned: 1,
      created: 1,
      updated: 0,
      detailsFilled: 1,
      mapsFilled: 1,
    });

    const { POST } = await import('./route');
    await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map((v) => JSON.stringify(v));
    expect(logged.some((entry) => entry.includes(SECRET))).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
