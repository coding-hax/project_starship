import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimedSlots = new Set<string>();
const insertValuesMock = vi.fn((row: { kind: string; sendDate: string; slot: string }) => {
  const key = `${row.kind}|${row.sendDate}|${row.slot}`;
  const isNew = !claimedSlots.has(key);
  if (isNew) claimedSlots.add(key);
  return {
    onConflictDoNothing: () => ({
      returning: () => Promise.resolve(isNew ? [{ id: row.kind }] : []),
    }),
  };
});

vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: (row: { kind: string; sendDate: string; slot: string }) => insertValuesMock(row) }),
  },
}));

const sendPushToAllMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/push/send', () => ({
  sendPushToAll: (...args: unknown[]) => sendPushToAllMock(...args),
}));

import type { ReminderKind } from './index';
import { sendDueReminders } from './index';

function kind(overrides: Partial<ReminderKind> = {}): ReminderKind {
  return {
    kind: 'test-kind',
    times: ['07:00'],
    build: async () => ({ title: 't', body: 'b', url: '/' }),
    ...overrides,
  };
}

// 08:00 Berlin (CEST, UTC+2) — past the 07:00 slot.
const AT_0800_BERLIN = new Date(Date.UTC(2026, 6, 15, 6, 0));

describe('sendDueReminders', () => {
  beforeEach(() => {
    claimedSlots.clear();
    insertValuesMock.mockClear();
    sendPushToAllMock.mockClear();
  });

  it('sends a due reminder and claims its slot', async () => {
    const result = await sendDueReminders(AT_0800_BERLIN, [kind()]);

    expect(result).toEqual({ sent: ['test-kind'], skipped: [] });
    expect(sendPushToAllMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a second time for the same day and slot', async () => {
    await sendDueReminders(AT_0800_BERLIN, [kind()]);
    sendPushToAllMock.mockClear();

    const result = await sendDueReminders(AT_0800_BERLIN, [kind()]);

    expect(result).toEqual({ sent: [], skipped: ['test-kind'] });
    expect(sendPushToAllMock).not.toHaveBeenCalled();
  });

  it('build() -> null sends nothing and writes no lock row', async () => {
    const result = await sendDueReminders(AT_0800_BERLIN, [kind({ build: async () => null })]);

    expect(result).toEqual({ sent: [], skipped: ['test-kind'] });
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendPushToAllMock).not.toHaveBeenCalled();

    // A later run the same day with something to report must still be able to send —
    // proof that the null build never claimed the slot for good.
    const second = await sendDueReminders(AT_0800_BERLIN, [kind()]);
    expect(second).toEqual({ sent: ['test-kind'], skipped: [] });
  });
});
