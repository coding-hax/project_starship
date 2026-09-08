import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createColdRouteProbe } from './global-setup';

/**
 * Exercises the actual probe `global-setup.ts` uses (issue #1142, AK1/AK2) — not just
 * the generic `waitForRouteReady` engine `route-readiness.test.ts` covers with a fake
 * probe. Stubs `fetch` globally (established pattern, see `src/app/api/ics/route.test.ts`)
 * so this stays a fast, DB-free Vitest test.
 */
describe('createColdRouteProbe', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fragt die authentifizierte /uebersicht-Route auf dem übergebenen Port an, nicht die Root-URL', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const probe = createColdRouteProbe(3100, 'token-123');

    await probe();

    expect(fetch).toHaveBeenCalledWith('http://localhost:3100/uebersicht', {
      headers: { cookie: 'starship_session=token-123' },
      redirect: 'manual',
    });
  });

  it('wertet HTTP 200 als bereit', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const probe = createColdRouteProbe(3100, 'token-123');

    await expect(probe()).resolves.toEqual({ ready: true, detail: 'ok' });
  });

  it('wertet eine 3xx-Antwort (Redirect nach /anmelden) als nicht bereit statt als Erfolg', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 307 }));
    const probe = createColdRouteProbe(3100, 'token-123');

    await expect(probe()).resolves.toEqual({ ready: false, detail: 'HTTP 307' });
  });

  it('wertet einen anderen Fehlerstatus ebenfalls als nicht bereit', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    const probe = createColdRouteProbe(3100, 'token-123');

    await expect(probe()).resolves.toEqual({ ready: false, detail: 'HTTP 500' });
  });

  it('wertet einen fehlgeschlagenen fetch (Server noch nicht erreichbar) als nicht bereit', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connect ECONNREFUSED'));
    const probe = createColdRouteProbe(3100, 'token-123');

    await expect(probe()).resolves.toEqual({ ready: false, detail: 'connect ECONNREFUSED' });
  });
});
