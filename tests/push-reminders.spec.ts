import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { resetAppData, resetPushData, resetReminderData, withDb } from './helpers';

/**
 * `e2e-smoke` (src/push/reminders/index.ts, gated behind NEXT_PUBLIC_E2E like the
 * hooks in src/app/sw.ts from #122) is due at any wall-clock time — its only job is
 * proving the cron -> lock -> push pipeline end to end. No push_subscriptions row
 * is seeded here, so `sendPushToAll` genuinely runs (real lock, real DB write) but
 * has nothing to actually deliver to — this suite verifies our own pipeline, not a
 * third-party push service's delivery (out of reach in headless CI, confirmed in
 * #122's push-sw.prod.spec.ts).
 */
async function reminderSendRows(kind: string): Promise<unknown[]> {
  const result = await withDb((client) => client.query('SELECT id FROM reminder_sends WHERE kind = $1', [kind]));
  return result.rows;
}

async function insertTask(overrides: {
  title?: string;
  dueAt?: string | null;
  priority?: number;
  completedAt?: string | null;
  deletedAt?: string | null;
} = {}): Promise<string> {
  const id = randomUUID();
  await withDb((client) =>
    client.query(
      `INSERT INTO tasks
        (id, updated_at, deleted_at, synced_at, sync_seq, title, notes, due_at, priority, completed_at, recurrence_rule, created_at, parent_id)
       VALUES
        ($1, now(), $2, now(), nextval('sync_seq'), $3, NULL, $4, $5, $6, NULL, now(), NULL)`,
      [
        id,
        overrides.deletedAt ?? null,
        overrides.title ?? 'Aufgabe',
        overrides.dueAt ?? null,
        overrides.priority ?? 0,
        overrides.completedAt ?? null,
      ],
    ),
  );
  return id;
}

test.beforeEach(async () => {
  await resetAppData();
  await resetPushData();
  await resetReminderData();
});

test('ein Cron-POST mit Owner-Session stellt eine fällige Erinnerung zu, ohne dass die App offen ist (AC1)', async ({
  request,
}) => {
  const response = await request.post('/api/push/reminders');
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.sent).toContain('e2e-smoke');
  expect(await reminderSendRows('e2e-smoke')).toHaveLength(1);
});

test('ein zweiter Auslöser am selben Berliner Kalendertag stellt denselben Slot nicht erneut zu (AC2)', async ({
  request,
}) => {
  await request.post('/api/push/reminders');

  const second = await request.post('/api/push/reminders');
  const body = await second.json();

  expect(body.sent).not.toContain('e2e-smoke');
  expect(body.skipped).toContain('e2e-smoke');
  expect(await reminderSendRows('e2e-smoke')).toHaveLength(1);
});

// The point of this one is the *absence* of a session, so it opts out of the
// shared owner state (same pattern as the "ohne Session" describe in sync.spec.ts).
test.describe('ohne Session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('ohne Secret und ohne Owner-Session: 401 (AC7)', async ({ request }) => {
    const response = await request.post('/api/push/reminders');
    expect(response.status()).toBe(401);
  });
});

/**
 * `tasks-due` (issue #241, "M3-T3"). Pinned past the 07:00 Berlin slot via
 * `X-E2E-Now` (route.ts) so the suite doesn't depend on the wall-clock hour it
 * happens to run at — same reasoning as `e2e-smoke` above.
 *
 * The exact notification text (singular/plural, "und N weitere", the Berlin
 * calendar-day boundary) is Vitest territory (src/push/reminders/tasks-due.test.ts)
 * — no push_subscriptions row is seeded here (see the module doc above), so there
 * is no way to observe the real payload's content through this HTTP layer, only
 * whether `tasks-due` fired. "Tippen öffnet /aufgaben" (AC5) is the generic
 * SW notificationclick behaviour already proven for any payload's `url` in
 * tests/push-sw.prod.spec.ts (#122); this suite only has to prove `tasks-due`
 * hands that handler `url: '/aufgaben'`, which tasks-due.test.ts already asserts.
 */
test.describe('tasks-due', () => {
  const AT_0705_BERLIN = { 'x-e2e-now': '2026-07-20T05:05:00.000Z' }; // 07:05 CEST

  test('eine heute fällige Aufgabe löst eine Erinnerung aus (AC1)', async ({ request }) => {
    await insertTask({ title: 'Steuererklärung', dueAt: '2026-07-20T18:00:00.000Z' });

    const response = await request.post('/api/push/reminders', { headers: AT_0705_BERLIN });
    const body = await response.json();

    expect(body.sent).toContain('tasks-due');
    expect(await reminderSendRows('tasks-due')).toHaveLength(1);
  });

  test('ohne fällige Aufgabe kommt keine Benachrichtigung (AC2)', async ({ request }) => {
    const response = await request.post('/api/push/reminders', { headers: AT_0705_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('tasks-due');
    expect(body.skipped).toContain('tasks-due');
    expect(await reminderSendRows('tasks-due')).toHaveLength(0);
  });

  test('erledigte und gelöschte Aufgaben lösen nichts aus (AC3)', async ({ request }) => {
    await insertTask({ title: 'Erledigt', dueAt: '2026-07-20T18:00:00.000Z', completedAt: '2026-07-20T09:00:00.000Z' });
    await insertTask({ title: 'Gelöscht', dueAt: '2026-07-20T18:00:00.000Z', deletedAt: '2026-07-20T09:00:00.000Z' });

    const response = await request.post('/api/push/reminders', { headers: AT_0705_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('tasks-due');
  });

  test('eine überfällige Aufgabe löst trotzdem aus (AC3)', async ({ request }) => {
    await insertTask({ title: 'Überfällig', dueAt: '2026-07-15T09:00:00.000Z' });

    const response = await request.post('/api/push/reminders', { headers: AT_0705_BERLIN });
    const body = await response.json();

    expect(body.sent).toContain('tasks-due');
  });
});
