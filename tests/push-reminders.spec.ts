import { expect, test } from '@playwright/test';
import { resetPushData, resetReminderData, withDb } from './helpers';

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

test.beforeEach(async () => {
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
