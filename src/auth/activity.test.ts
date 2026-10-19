import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateWhere = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();
const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
vi.mock('@/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: updateWhere }) }),
    insert: (...args: unknown[]) => {
      insertValues(...args);
      return { values: () => ({ onConflictDoNothing }) };
    },
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
