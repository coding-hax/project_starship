import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireOwnerMock = vi.fn();
vi.mock('@/auth/session', () => ({
  requireOwner: (...args: unknown[]) => requireOwnerMock(...args),
}));

const sendDueRemindersMock = vi.fn();
vi.mock('@/push/reminders', () => ({
  sendDueReminders: (...args: unknown[]) => sendDueRemindersMock(...args),
}));

const SECRET = 'top-secret-reminder-value';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/push/reminders', { method: 'POST', headers });
}

describe('POST /api/push/reminders', () => {
  beforeEach(() => {
    vi.stubEnv('REMINDER_SECRET', SECRET);
    requireOwnerMock.mockReset().mockRejectedValue(new Error('no session'));
    sendDueRemindersMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers 503 when REMINDER_SECRET is not set — never falls open', async () => {
    vi.stubEnv('REMINDER_SECRET', '');
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(503);
    expect(sendDueRemindersMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a bearer header and without an owner session', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest());
    expect(response.status).toBe(401);
    expect(sendDueRemindersMock).not.toHaveBeenCalled();
  });

  it('answers 401 with a wrong bearer token', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ authorization: 'Bearer wrong-value' }));
    expect(response.status).toBe(401);
    expect(sendDueRemindersMock).not.toHaveBeenCalled();
  });

  it('answers 200 with the correct bearer token and returns sent/skipped', async () => {
    sendDueRemindersMock.mockResolvedValue({ sent: ['tasks-due'], skipped: ['habits-open'] });
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ authorization: `Bearer ${SECRET}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ sent: ['tasks-due'], skipped: ['habits-open'] });
  });

  it('a valid owner session authorizes too — the manual kick from the app', async () => {
    requireOwnerMock.mockResolvedValue('owner-id');
    sendDueRemindersMock.mockResolvedValue({ sent: [], skipped: [] });
    const { POST } = await import('./route');

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
  });

  it('honors X-E2E-Now under NEXT_PUBLIC_E2E — lets a test pin the 07:00 slot', async () => {
    vi.stubEnv('NEXT_PUBLIC_E2E', '1');
    sendDueRemindersMock.mockResolvedValue({ sent: [], skipped: [] });
    const { POST } = await import('./route');

    await POST(makeRequest({ authorization: `Bearer ${SECRET}`, 'x-e2e-now': '2026-07-20T05:05:00.000Z' }));

    expect(sendDueRemindersMock).toHaveBeenCalledWith(new Date('2026-07-20T05:05:00.000Z'));
  });

  it('ignores X-E2E-Now outside NEXT_PUBLIC_E2E — never lets a client fake the clock in prod', async () => {
    sendDueRemindersMock.mockResolvedValue({ sent: [], skipped: [] });
    const { POST } = await import('./route');

    await POST(makeRequest({ authorization: `Bearer ${SECRET}`, 'x-e2e-now': '2026-07-20T05:05:00.000Z' }));

    expect(sendDueRemindersMock).not.toHaveBeenCalledWith(new Date('2026-07-20T05:05:00.000Z'));
  });
});
