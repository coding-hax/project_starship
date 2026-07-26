import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebPushError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

const sendNotification = vi.fn();

vi.mock('./vapid', () => ({
  ensureVapidConfigured: vi.fn(),
  webpush: { sendNotification, WebPushError: FakeWebPushError },
}));

let subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[] = [];
const deleteWhere = vi.fn().mockResolvedValue(undefined);

vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => Promise.resolve(subscriptions) }),
    delete: () => ({ where: deleteWhere }),
  },
}));

describe('sendPushToAll', () => {
  beforeEach(() => {
    sendNotification.mockReset();
    deleteWhere.mockClear();
  });

  it('deletes the subscription outright on a 410 from the push service', async () => {
    subscriptions = [{ id: 'sub-1', endpoint: 'https://push.example/gone', p256dh: 'p', auth: 'a' }];
    sendNotification.mockRejectedValue(new FakeWebPushError('gone', 410));

    const { sendPushToAll } = await import('./send');
    await sendPushToAll({ title: 't', body: 'b', url: '/' });

    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('deletes the subscription outright on a 404 from the push service', async () => {
    subscriptions = [{ id: 'sub-1', endpoint: 'https://push.example/missing', p256dh: 'p', auth: 'a' }];
    sendNotification.mockRejectedValue(new FakeWebPushError('missing', 404));

    const { sendPushToAll } = await import('./send');
    await sendPushToAll({ title: 't', body: 'b', url: '/' });

    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription and never logs endpoint/keys on any other failure (AC5)', async () => {
    subscriptions = [
      { id: 'sub-1', endpoint: 'https://push.example/flaky', p256dh: 'secret-p256dh', auth: 'secret-auth' },
    ];
    sendNotification.mockRejectedValue(new Error('ECONNRESET'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { sendPushToAll } = await import('./send');
    await sendPushToAll({ title: 't', body: 'b', url: '/' });

    expect(deleteWhere).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Push delivery failed', {
      subscriptionId: 'sub-1',
      statusCode: undefined,
    });
    errorSpy.mockRestore();
  });

  it('sends to every subscription and never sends the raw endpoint/keys to console.error on success', async () => {
    subscriptions = [
      { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p1', auth: 'a1' },
      { id: 'sub-2', endpoint: 'https://push.example/b', p256dh: 'p2', auth: 'a2' },
    ];
    sendNotification.mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { sendPushToAll } = await import('./send');
    await sendPushToAll({ title: 't', body: 'b', url: '/' });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
