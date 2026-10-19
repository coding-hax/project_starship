import { describe, expect, it, vi } from 'vitest';

/**
 * Separate from index.test.ts on purpose: that file injects `loadUsers` into
 * `sendDueReminders` precisely so its tests never exercise the real
 * `loadDeliverableUsers()` SQL (see its own doc comment) — this is the one place
 * that does. `isNull` is spied, not stubbed, so the assertion is "the production
 * code builds this predicate", not "this mock returns whatever I told it to".
 */
const rows: Array<{ id: string; role: 'admin' | 'user' }> = [{ id: 'user-a', role: 'user' }];

const { whereMock, fromMock, selectMock } = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  return { whereMock, fromMock, selectMock };
});
whereMock.mockResolvedValue(rows);

vi.mock('@/db', () => ({ db: { select: selectMock } }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, isNull: vi.fn(actual.isNull) };
});

import { isNull } from 'drizzle-orm';
import { users } from '@/db/schema';
import { loadDeliverableUsers } from './index';

describe('loadDeliverableUsers (#1205 AC3)', () => {
  it('selects id+role from users, filtered on blockedAt IS NULL', async () => {
    const result = await loadDeliverableUsers();

    expect(selectMock).toHaveBeenCalledWith({ id: users.id, role: users.role });
    expect(fromMock).toHaveBeenCalledWith(users);
    expect(isNull).toHaveBeenCalledWith(users.blockedAt);
    expect(result).toBe(rows);
  });
});
