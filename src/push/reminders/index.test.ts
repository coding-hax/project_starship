import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimedSlots = new Set<string>();
const insertValuesMock = vi.fn(
  (row: { userId: string; kind: string; sendDate: string; slot: string }) => {
    // The real unique index carries `user_id` since #1200 — so does this stand-in,
    // or the "two accounts, same slot, same day" case below would pass for the
    // wrong reason.
    const key = `${row.userId}|${row.kind}|${row.sendDate}|${row.slot}`;
    const isNew = !claimedSlots.has(key);
    if (isNew) claimedSlots.add(key);
    return {
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve(isNew ? [{ id: row.kind }] : []),
      }),
    };
  },
);

let prefRows: Array<{ kind: string; enabled: boolean; times: string[] }> = [];

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: (row: { userId: string; kind: string; sendDate: string; slot: string }) =>
        insertValuesMock(row),
    }),
    select: () => ({ from: () => ({ where: () => Promise.resolve(prefRows) }) }),
  },
}));

const sendPushToUserMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/push/send', () => ({
  sendPushToUser: (...args: unknown[]) => sendPushToUserMock(...args),
}));

import type { ReminderKind, ReminderPref } from './index';
import { sendDueReminders } from './index';

const ALICE = { id: 'user-alice', role: 'user' as const };
const BOB = { id: 'user-bob', role: 'user' as const };
const ADMIN = { id: 'user-admin', role: 'admin' as const };

function kind(overrides: Partial<ReminderKind> = {}): ReminderKind {
  return {
    kind: 'test-kind',
    times: ['07:00'],
    build: async () => ({ title: 't', body: 'b', url: '/' }),
    ...overrides,
  };
}

/**
 * The prefs/events/users loaders are injected rather than mocked at the db
 * level: one tick now walks every account (ADR-0031), and `loadDeliverableUsers`
 * and `loadReminderPrefs` would otherwise both come back as the same stubbed
 * `db.select()`.
 */
function run(
  now: Date,
  kinds: ReminderKind[],
  users: Array<{ id: string; role: 'admin' | 'user' }> = [ALICE],
) {
  const loadPrefs = async () =>
    new Map<string, ReminderPref>(
      prefRows.map((row) => [row.kind, { enabled: row.enabled, times: row.times }]),
    );
  return sendDueReminders(now, kinds, loadPrefs, async () => [], async () => users);
}

// 08:00 Berlin (CEST, UTC+2) — past the 07:00 slot.
const AT_0800_BERLIN = new Date(Date.UTC(2026, 6, 15, 6, 0));

describe('sendDueReminders', () => {
  beforeEach(() => {
    claimedSlots.clear();
    insertValuesMock.mockClear();
    sendPushToUserMock.mockClear();
    prefRows = [];
  });

  it('sends a due reminder and claims its slot', async () => {
    const result = await run(AT_0800_BERLIN, [kind()]);

    expect(result).toEqual({ sent: ['test-kind'], skipped: [] });
    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a second time for the same day and slot', async () => {
    await run(AT_0800_BERLIN, [kind()]);
    sendPushToUserMock.mockClear();

    const result = await run(AT_0800_BERLIN, [kind()]);

    expect(result).toEqual({ sent: [], skipped: ['test-kind'] });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it('build() -> null sends nothing and writes no lock row', async () => {
    const result = await run(AT_0800_BERLIN, [kind({ build: async () => null })]);

    expect(result).toEqual({ sent: [], skipped: ['test-kind'] });
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendPushToUserMock).not.toHaveBeenCalled();

    // A later run the same day with something to report must still be able to send —
    // proof that the null build never claimed the slot for good.
    const second = await run(AT_0800_BERLIN, [kind()]);
    expect(second).toEqual({ sent: ['test-kind'], skipped: [] });
  });

  // 09:00 Berlin (CEST, UTC+2) — one hour past AT_0800_BERLIN, used for the
  // times-override case below.
  const AT_0900_BERLIN = new Date(Date.UTC(2026, 6, 15, 7, 0));

  describe('reminder_prefs overrides (issue #244)', () => {
    it('no pref for the kind: sends at the registry default time', async () => {
      const result = await run(AT_0800_BERLIN, [kind()]);

      expect(result).toEqual({ sent: ['test-kind'], skipped: [] });
    });

    it('enabled: false — no slot at all, even past the registry default time', async () => {
      prefRows = [{ kind: 'test-kind', enabled: false, times: ['07:00'] }];

      const result = await run(AT_0800_BERLIN, [kind()]);

      expect(result).toEqual({ sent: [], skipped: [] });
      expect(sendPushToUserMock).not.toHaveBeenCalled();
    });

    it('times override: fires at the overridden time, not the registry default', async () => {
      prefRows = [{ kind: 'test-kind', enabled: true, times: ['09:00'] }];

      const before = await run(AT_0800_BERLIN, [kind()]);
      expect(before).toEqual({ sent: [], skipped: [] });

      const after = await run(AT_0900_BERLIN, [kind()]);
      expect(after).toEqual({ sent: ['test-kind'], skipped: [] });
    });

    it('empty times override: nothing sends, the registry default does not come back', async () => {
      prefRows = [{ kind: 'test-kind', enabled: true, times: [] }];

      const result = await run(AT_0800_BERLIN, [kind()]);

      expect(result).toEqual({ sent: [], skipped: [] });
      expect(sendPushToUserMock).not.toHaveBeenCalled();
    });
  });

  describe('one tick, every account (ADR-0031)', () => {
    it('builds and delivers once per account, each to its own devices', async () => {
      const seen: string[] = [];
      const result = await run(
        AT_0800_BERLIN,
        [kind({ build: async (_now, userId) => {
          seen.push(userId);
          return { title: 't', body: 'b', url: '/' };
        } })],
        [ALICE, BOB],
      );

      expect(seen).toEqual([ALICE.id, BOB.id]);
      expect(result.sent).toEqual(['test-kind', 'test-kind']);
      expect(sendPushToUserMock.mock.calls.map((call) => call[0])).toEqual([ALICE.id, BOB.id]);
    });

    it('an account with nothing to report costs the other account nothing', async () => {
      const result = await run(
        AT_0800_BERLIN,
        [kind({ build: async (_now, userId) =>
          userId === ALICE.id ? { title: 't', body: 'b', url: '/' } : null,
        })],
        [ALICE, BOB],
      );

      expect(result).toEqual({ sent: ['test-kind'], skipped: ['test-kind'] });
      expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
      expect(sendPushToUserMock.mock.calls[0][0]).toBe(ALICE.id);
    });

    it('two accounts claim the same slot on the same day — the lock is per account', async () => {
      const first = await run(AT_0800_BERLIN, [kind()], [ALICE, BOB]);
      expect(first.sent).toEqual(['test-kind', 'test-kind']);

      // …and neither of them a second time.
      const second = await run(AT_0800_BERLIN, [kind()], [ALICE, BOB]);
      expect(second).toEqual({ sent: [], skipped: ['test-kind', 'test-kind'] });
    });

    it('an adminOnly kind reaches admins and nobody else', async () => {
      const result = await run(AT_0800_BERLIN, [kind({ adminOnly: true })], [ALICE, ADMIN]);

      expect(result).toEqual({ sent: ['test-kind'], skipped: [] });
      expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
      expect(sendPushToUserMock.mock.calls[0][0]).toBe(ADMIN.id);
    });

    it('one account throwing does not cost the next account its reminder', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await run(
          AT_0800_BERLIN,
          [kind({ build: async (_now, userId) => {
            if (userId === ALICE.id) throw new Error('kaputte Zeile');
            return { title: 't', body: 'b', url: '/' };
          } })],
          [ALICE, BOB],
        );

        expect(result.sent).toEqual(['test-kind']);
        expect(sendPushToUserMock.mock.calls.map((call) => call[0])).toEqual([BOB.id]);
        // Logged by account and message — never the payload, which is the
        // account's own data.
        expect(consoleError).toHaveBeenCalledWith('[reminders] account skipped', {
          userId: ALICE.id,
          error: 'kaputte Zeile',
        });
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
