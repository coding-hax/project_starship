import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { habitLogs, habits, tasks } from '@/db/schema';
import { readChangesSince } from './route';

vi.mock('@/auth/session', () => ({
  requireOwner: vi.fn().mockResolvedValue('owner-id'),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

/**
 * Real Postgres (DATABASE_URL from .env.local), not a mock. Fund F1 (#472) is a
 * gap in MVCC snapshot semantics between two statements — a mock has no
 * transaction semantics to get wrong in the first place, so only a real database
 * can reproduce the bug or prove the fix.
 */

/**
 * Wraps a `select`-capable executor so that the read of `targetTable` pauses
 * right before it executes (queries are lazy in drizzle until awaited, so
 * building `.from()`/`.where()` never touches the database) and runs `onPause`
 * first. Used to commit a write deterministically *between* two reads of a pull,
 * without a timing-dependent race (an E2E test could not do this).
 */
function pauseBeforeTable<E extends Pick<typeof db, 'select'>>(
  executor: E,
  targetTable: object,
  onPause: () => Promise<void>,
): E {
  return new Proxy(executor, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver);
      const originalSelect = Reflect.get(target, prop, receiver) as E['select'];
      return (...args: Parameters<E['select']>) => {
        const builder = originalSelect.apply(target, args);
        return new Proxy(builder, {
          get(builderTarget, builderProp, builderReceiver) {
            if (builderProp !== 'from') return Reflect.get(builderTarget, builderProp, builderReceiver);
            const originalFrom = Reflect.get(builderTarget, builderProp, builderReceiver) as typeof builderTarget.from;
            return (table: Parameters<typeof originalFrom>[0]) => {
              const fromResult = originalFrom.call(builderTarget, table);
              if (table !== targetTable) return fromResult;
              return new Proxy(fromResult, {
                get(fromTarget, fromProp, fromReceiver) {
                  if (fromProp !== 'where') return Reflect.get(fromTarget, fromProp, fromReceiver);
                  const originalWhere = Reflect.get(fromTarget, fromProp, fromReceiver) as typeof fromTarget.where;
                  return (condition: Parameters<typeof originalWhere>[0]) => {
                    const whereResult = originalWhere.call(fromTarget, condition);
                    return new Proxy(whereResult, {
                      get(whereTarget, whereProp, whereReceiver) {
                        if (whereProp !== 'orderBy') return Reflect.get(whereTarget, whereProp, whereReceiver);
                        const originalOrderBy = Reflect.get(whereTarget, whereProp, whereReceiver) as typeof whereTarget.orderBy;
                        return (...orderArgs: Parameters<typeof originalOrderBy>) =>
                          (async () => {
                            await onPause();
                            return originalOrderBy.apply(whereTarget, orderArgs);
                          })();
                      },
                    });
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

describe('pull snapshot consistency (fund F1, #472)', () => {
  const createdHabitIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdLogIds: string[] = [];

  afterEach(async () => {
    for (const id of createdLogIds.splice(0)) {
      await db.delete(habitLogs).where(eq(habitLogs.id, id));
    }
    for (const id of createdTaskIds.splice(0)) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    for (const id of createdHabitIds.splice(0)) {
      await db.delete(habits).where(eq(habits.id, id));
    }
  });

  /**
   * `since` is the just-inserted habit's own sequence number — every row this
   * test cares about is strictly newer than that, so pre-existing/unrelated
   * rows in the dev database can never leak into the assertions.
   */
  async function setUp() {
    const habitId = crypto.randomUUID();
    const [habitRow] = await db
      .insert(habits)
      .values({ id: habitId, name: 'Testgewohnheit', schedule: 'daily', syncSeq: sql`nextval('sync_seq')` })
      .returning({ syncSeq: habits.syncSeq });
    createdHabitIds.push(habitId);

    // Mirrors what push/route.ts does for a create: a fresh sequence value per
    // write, assigned by the database, not the client.
    async function commitPush(): Promise<{ taskSeq: number; logSeq: number }> {
      const taskId = crypto.randomUUID();
      const [taskRow] = await db
        .insert(tasks)
        .values({ id: taskId, title: 'Testaufgabe', syncSeq: sql`nextval('sync_seq')` })
        .returning({ syncSeq: tasks.syncSeq });
      createdTaskIds.push(taskId);

      const logId = crypto.randomUUID();
      const [logRow] = await db
        .insert(habitLogs)
        .values({
          id: logId,
          habitId,
          logDate: '2026-08-03',
          syncSeq: sql`nextval('sync_seq')`,
        })
        .returning({ syncSeq: habitLogs.syncSeq });
      createdLogIds.push(logId);

      return { taskSeq: taskRow.syncSeq, logSeq: logRow.syncSeq };
    }

    return { since: habitRow.syncSeq, commitPush };
  }

  it('without a shared snapshot, a push between two reads loses the older row for good', async () => {
    const { since, commitPush } = await setUp();
    let pushed: { taskSeq: number; logSeq: number } | undefined;

    // `db` itself (no `.transaction`): every `.select()` autocommits on its own,
    // exactly like the pre-fix loop in route.ts used to.
    const executor = pauseBeforeTable(db, habitLogs, async () => {
      pushed = await commitPush();
    });

    const changes = await readChangesSince(executor, since);

    expect(pushed).toBeDefined();
    const hasTask = changes.some((c) => c.table === 'tasks' && c.syncSeq === pushed?.taskSeq);
    const hasLog = changes.some((c) => c.table === 'habit_logs' && c.syncSeq === pushed?.logSeq);

    // The gap from the fund: the newer row (habit_logs) is visible, the older
    // one (tasks, read before the push committed) is not — a client would move
    // its cursor past the task's sequence and never see it again.
    expect(hasLog).toBe(true);
    expect(hasTask).toBe(false);
  });

  it('AK2: a repeatable-read, read-only transaction sees one consistent snapshot — no gap', async () => {
    const { since, commitPush } = await setUp();
    let pushed: { taskSeq: number; logSeq: number } | undefined;

    const changes = await db.transaction(
      (tx) => {
        const executor = pauseBeforeTable(tx, habitLogs, async () => {
          pushed = await commitPush();
        });
        return readChangesSince(executor, since);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    expect(pushed).toBeDefined();
    const hasTask = changes.some((c) => c.table === 'tasks' && c.syncSeq === pushed?.taskSeq);
    const hasLog = changes.some((c) => c.table === 'habit_logs' && c.syncSeq === pushed?.logSeq);

    // The transaction's snapshot predates the push, so neither row is visible
    // yet — but crucially the invariant from AK2 holds either way: a habit_log
    // never appears without its lower-sequence sibling task.
    expect(hasTask).toBe(false);
    expect(hasLog).toBe(false);
    if (hasLog) expect(hasTask).toBe(true);
  });

  it('AK1: GET wires the read through exactly one transaction with a repeatable-read, read-only snapshot', async () => {
    vi.resetModules();
    const transactionSpy = vi.fn((callback: (tx: unknown) => unknown, _options: unknown) => {
      const tx = {
        select: () => ({
          from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
        }),
      };
      return callback(tx);
    });
    vi.doMock('@/db', () => ({ db: { transaction: transactionSpy } }));

    try {
      const { GET } = await import('./route');
      const response = await GET(new Request('http://localhost/api/sync/pull?since=0'));

      expect(response.status).toBe(200);
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy.mock.calls[0]?.[1]).toEqual({
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    } finally {
      vi.doUnmock('@/db');
      vi.resetModules();
    }
  });
});
