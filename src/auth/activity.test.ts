import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateWhere = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();
const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const deleteWhere = vi.fn().mockResolvedValue(undefined);
vi.mock('@/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: updateWhere }) }),
    insert: (...args: unknown[]) => {
      insertValues(...args);
      return { values: () => ({ onConflictDoNothing }) };
    },
    delete: () => ({ where: deleteWhere }),
  },
}));

/**
 * `recordActivity()` is what `requireUser()` calls on every request (#1203 AK3) —
 * the throttle has to be race-safe and cheap, not "mostly right". Mirrors
 * session.test.ts's `touchLastSeen` coverage.
 */
describe('recordActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes nothing when the account was seen inside the last hour', async () => {
    const { recordActivity } = await import('./activity');
    const recent = new Date(Date.now() - 10 * 60 * 1000);

    await recordActivity('user-uuid', recent);

    expect(updateWhere).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('writes both last_seen_at and today once the throttle window is open (stale timestamp)', async () => {
    const { recordActivity } = await import('./activity');
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await recordActivity('user-uuid', stale);

    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('writes both on a never-seen account (null)', async () => {
    const { recordActivity } = await import('./activity');

    await recordActivity('user-uuid', null);

    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
  });
});

/** `currentWindowStart()` is the AK1 "auf volle 5 Minuten UTC abgerundet" rule. */
describe('currentWindowStart', () => {
  it('rounds down to the start of the enclosing 5-minute UTC window', async () => {
    const { currentWindowStart } = await import('./activity');

    expect(currentWindowStart(new Date('2026-01-01T10:07:59.999Z'))).toEqual(
      new Date('2026-01-01T10:05:00.000Z'),
    );
    expect(currentWindowStart(new Date('2026-01-01T10:10:00.000Z'))).toEqual(
      new Date('2026-01-01T10:10:00.000Z'),
    );
  });
});

/**
 * `recordActivityWindow`/`recordSystemWindow` sit on the path of every request
 * (account windows through `requireUser()`) or of a public/unauthenticated route
 * (`/api/health`, the reminder cron) — a database hiccup here must never fail
 * the request (#1233 AK2).
 */
describe('recordActivityWindow / recordSystemWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onConflictDoNothing.mockResolvedValue(undefined);
    deleteWhere.mockResolvedValue(undefined);
  });

  it('upserts the account window and prunes old windows', async () => {
    const { recordActivityWindow } = await import('./activity');

    await recordActivityWindow('user-uuid');

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('upserts the system window and prunes old windows', async () => {
    const { recordSystemWindow } = await import('./activity');

    await recordSystemWindow('cron');

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the insert fails (AK2)', async () => {
    const { recordActivityWindow, recordSystemWindow } = await import('./activity');
    onConflictDoNothing.mockRejectedValueOnce(new Error('db down'));
    await expect(recordActivityWindow('user-uuid')).resolves.toBeUndefined();

    onConflictDoNothing.mockRejectedValueOnce(new Error('db down'));
    await expect(recordSystemWindow('deploy-probe')).resolves.toBeUndefined();
  });

  it('never rejects when the prune fails (AK2)', async () => {
    const { recordActivityWindow } = await import('./activity');
    deleteWhere.mockRejectedValueOnce(new Error('db down'));

    await expect(recordActivityWindow('user-uuid')).resolves.toBeUndefined();
  });
});
