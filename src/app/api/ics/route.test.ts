import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireOwnerMock = vi.fn();
const { MockUnauthorizedError } = vi.hoisted(() => ({
  MockUnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/auth/session', () => ({
  requireOwner: (...args: unknown[]) => requireOwnerMock(...args),
  UnauthorizedError: MockUnauthorizedError,
}));

const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
}));

function makeRequest(url: string): Request {
  return new Request(url);
}

describe('GET /api/ics', () => {
  beforeEach(() => {
    requireOwnerMock.mockReset().mockResolvedValue('owner-id');
    dnsLookupMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 401 without an owner session', async () => {
    requireOwnerMock.mockRejectedValue(new MockUnauthorizedError('no session'));
    const { GET } = await import('./route');

    const response = await GET(makeRequest('http://localhost/api/ics?url=https://example.com/feiertage.ics'));

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 400 when url is missing', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('http://localhost/api/ics'));
    expect(response.status).toBe(400);
  });

  it('answers 400 for a non-https URL', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('http://localhost/api/ics?url=http://example.com/feiertage.ics'));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 403 when the resolved address is internal', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '127.0.0.1' }]);
    const { GET } = await import('./route');

    const response = await GET(
      makeRequest('http://localhost/api/ics?url=https://internal.example.com/feiertage.ics'),
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 403 when a redirect points at an internal address', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://internal.example.com/feiertage.ics' } }),
    );
    dnsLookupMock.mockResolvedValueOnce([{ address: '93.184.216.34' }]);
    dnsLookupMock.mockResolvedValueOnce([{ address: '169.254.169.254' }]);
    const { GET } = await import('./route');

    const response = await GET(makeRequest('http://localhost/api/ics?url=https://example.com/feiertage.ics'));

    expect(response.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with the fetched ICS text on a clean fetch', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    const icsBody = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
    vi.mocked(fetch).mockResolvedValue(new Response(icsBody, { status: 200 }));
    const { GET } = await import('./route');

    const response = await GET(makeRequest('http://localhost/api/ics?url=https://example.com/feiertage.ics'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(icsBody);
    expect(response.headers.get('content-type')).toBe('text/calendar');
  });

  it('answers 502 when the upstream fetch rejects', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    const { GET } = await import('./route');

    const response = await GET(makeRequest('http://localhost/api/ics?url=https://example.com/feiertage.ics'));

    expect(response.status).toBe(502);
  });

  it('answers 502 when the body exceeds the size cap', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
    const oversized = 'a'.repeat(6 * 1024 * 1024);
    vi.mocked(fetch).mockResolvedValue(new Response(oversized, { status: 200 }));
    const { GET } = await import('./route');

    const response = await GET(makeRequest('http://localhost/api/ics?url=https://example.com/feiertage.ics'));

    expect(response.status).toBe(502);
  });
});
