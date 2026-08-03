import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { resetAppData, resetPushData, resetReminderData, seedReminderPref, withDb } from './helpers';

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

async function insertHabit(overrides: {
  name?: string;
  schedule?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
  target?: number;
  archivedAt?: string | null;
  deletedAt?: string | null;
} = {}): Promise<string> {
  const id = randomUUID();
  await withDb((client) =>
    client.query(
      `INSERT INTO habits
        (id, updated_at, deleted_at, synced_at, sync_seq, name, schedule, target, color, archived_at, created_at)
       VALUES
        ($1, now(), $2, now(), nextval('sync_seq'), $3, $4, $5, NULL, $6, now())`,
      [
        id,
        overrides.deletedAt ?? null,
        overrides.name ?? 'Laufen',
        overrides.schedule ?? 'daily',
        overrides.target ?? 1,
        overrides.archivedAt ?? null,
      ],
    ),
  );
  return id;
}

async function insertHabitLog(habitId: string, logDate: string, done = true): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO habit_logs (id, updated_at, deleted_at, synced_at, sync_seq, habit_id, log_date, done)
       VALUES ($1, now(), NULL, now(), nextval('sync_seq'), $2, $3, $4)`,
      [randomUUID(), habitId, logDate, done],
    ),
  );
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

/**
 * `habits-open` (issue #243, "M3-T4"). Pinned past the 20:00 Berlin slot the same
 * way `tasks-due` above pins past 07:00 — `2026-07-15` is a Wednesday, so its
 * Mon–Sun week (07-13..07-19) has days on both sides for the weekly case.
 *
 * As with `tasks-due`, the exact notification text (name, "und N weitere", the
 * streak suffix) is Vitest territory (src/push/reminders/habits-open.test.ts) —
 * no push_subscriptions row is seeded here, so this suite only proves whether
 * `habits-open` fires, not what it says. "Tippen öffnet /gewohnheiten" (AC6) is
 * the generic SW notificationclick behaviour already proven for any payload's
 * `url` in tests/push-sw.prod.spec.ts (#122); habits-open.test.ts already asserts
 * it hands that handler `url: '/gewohnheiten'`.
 */
test.describe('habits-open', () => {
  const AT_2005_BERLIN = { 'x-e2e-now': '2026-07-15T18:05:00.000Z' }; // 20:05 CEST, a Wednesday

  test('eine offene Gewohnheit löst eine Erinnerung aus (AC1)', async ({ request }) => {
    await insertHabit({ name: 'Laufen' });

    const response = await request.post('/api/push/reminders', { headers: AT_2005_BERLIN });
    const body = await response.json();

    expect(body.sent).toContain('habits-open');
    expect(await reminderSendRows('habits-open')).toHaveLength(1);
  });

  test('ist alles abgehakt, kommt keine Benachrichtigung (AC2)', async ({ request }) => {
    const habitId = await insertHabit({ name: 'Laufen' });
    await insertHabitLog(habitId, '2026-07-15');

    const response = await request.post('/api/push/reminders', { headers: AT_2005_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('habits-open');
    expect(body.skipped).toContain('habits-open');
  });

  test('eine wöchentliche Gewohnheit, diese Woche schon erledigt, gilt nicht als offen (AC3)', async ({
    request,
  }) => {
    const habitId = await insertHabit({ name: 'Wocheneinkauf', schedule: 'weekly' });
    await insertHabitLog(habitId, '2026-07-13'); // Monday — same Mon–Sun week, not today

    const response = await request.post('/api/push/reminders', { headers: AT_2005_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('habits-open');
  });

  test('archivierte Gewohnheiten erscheinen nie (AC4)', async ({ request }) => {
    await insertHabit({ name: 'Alte Gewohnheit', archivedAt: '2026-06-01T00:00:00.000Z' });

    const response = await request.post('/api/push/reminders', { headers: AT_2005_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('habits-open');
  });

  /**
   * Owner-Entscheidung 2 (issue #509, AC6): the reminder only mentions a habit
   * once its period is actually running out — a weekly habit stays silent on
   * Wednesday no matter what, and only speaks up on the last day of its week.
   */
  const AT_2005_BERLIN_LAST_DAY_OF_WEEK = { 'x-e2e-now': '2026-07-19T18:05:00.000Z' }; // Sunday 20:05 CEST

  test('eine offene wöchentliche Gewohnheit bleibt vor dem letzten Tag der Woche still (issue #509)', async ({
    request,
  }) => {
    await insertHabit({ name: 'Wocheneinkauf', schedule: 'weekly' });

    // AT_2005_BERLIN is Wednesday — the week only ends on Sunday.
    const response = await request.post('/api/push/reminders', { headers: AT_2005_BERLIN });
    const body = await response.json();

    expect(body.sent).not.toContain('habits-open');
  });

  test('eine offene wöchentliche Gewohnheit meldet sich am letzten Tag der Woche (issue #509)', async ({
    request,
  }) => {
    await insertHabit({ name: 'Wocheneinkauf', schedule: 'weekly' });

    const response = await request.post('/api/push/reminders', {
      headers: AT_2005_BERLIN_LAST_DAY_OF_WEEK,
    });
    const body = await response.json();

    expect(body.sent).toContain('habits-open');
  });

  test('eine „3x pro Woche"-Gewohnheit mit 2 von 3 gilt am letzten Tag der Woche noch als offen (issue #509)', async ({
    request,
  }) => {
    const habitId = await insertHabit({ name: 'Krafttraining', schedule: 'weekly', target: 3 });
    await insertHabitLog(habitId, '2026-07-13');
    await insertHabitLog(habitId, '2026-07-14');

    const response = await request.post('/api/push/reminders', {
      headers: AT_2005_BERLIN_LAST_DAY_OF_WEEK,
    });
    const body = await response.json();

    expect(body.sent).toContain('habits-open');
  });

  test('eine jährliche Gewohnheit bleibt still, wenn mehr als 7 Tage bis Jahresende bleiben (issue #509 AC6)', async ({
    request,
  }) => {
    await insertHabit({ name: 'Testament prüfen', schedule: 'yearly' });

    const response = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-12-01T19:05:00.000Z' }, // 20:05 CET, 30 Tage bis Jahresende
    });
    const body = await response.json();

    expect(body.sent).not.toContain('habits-open');
  });

  test('eine jährliche Gewohnheit meldet sich innerhalb der letzten 7 Tage des Jahres (issue #509 AC6)', async ({
    request,
  }) => {
    await insertHabit({ name: 'Testament prüfen', schedule: 'yearly' });

    const response = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-12-28T19:05:00.000Z' }, // 20:05 CET, 3 Tage bis Jahresende
    });
    const body = await response.json();

    expect(body.sent).toContain('habits-open');
  });
});

/**
 * `interaction-limit` (issue #245, "M3-T6"). Its `build()` compares `now` against
 * the fixed expiry constant (src/push/reminders/interaction-limit.ts) instead of
 * reading anything from the database, so — unlike tasks-due/habits-open above —
 * there is nothing to seed here, only `X-E2E-Now` to place `now` at a chosen
 * distance from that expiry. Both dates below sit past the 09:00 Berlin slot so
 * the only variable under test is the day-distance, not slot timing.
 */
test.describe('interaction-limit', () => {
  test('weniger als 30 Tage bis zum Ablauf lösen eine Erinnerung aus (AC1)', async ({ request }) => {
    // 12 Tage vor Ablauf (2027-01-17T11:36:24Z), 09:05 CET
    const response = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2027-01-05T08:05:00.000Z' },
    });
    const body = await response.json();

    expect(body.sent).toContain('interaction-limit');
    expect(await reminderSendRows('interaction-limit')).toHaveLength(1);
  });

  test('mehr als 30 Tage bis zum Ablauf lösen keine Erinnerung aus (AC2)', async ({ request }) => {
    // ~180 Tage vor Ablauf, 09:05 CEST
    const response = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-07-20T07:05:00.000Z' },
    });
    const body = await response.json();

    expect(body.sent).not.toContain('interaction-limit');
    expect(body.skipped).toContain('interaction-limit');
    expect(await reminderSendRows('interaction-limit')).toHaveLength(0);
  });
});

/**
 * `reminder_prefs` (issue #244, "M3-T5"), exercised through `e2e-smoke` — its
 * always-due `00:00` registry default means any override observed here is
 * unambiguously the pref's doing, not a coincidence of the wall-clock hour the
 * suite happens to run at. The panel/outbox path that produces these rows is
 * `tests/reminder-prefs.spec.ts`; this suite only proves the cron reads them.
 */
test.describe('reminder_prefs (e2e-smoke)', () => {
  test('abgeschaltete Art bleibt still, auch wenn ihre Zeit vergangen ist (AC1)', async ({ request }) => {
    await seedReminderPref('e2e-smoke', false, ['00:00']);

    const response = await request.post('/api/push/reminders');
    const body = await response.json();

    expect(body.sent).not.toContain('e2e-smoke');
    expect(await reminderSendRows('e2e-smoke')).toHaveLength(0);
  });

  test('eine geänderte Uhrzeit wirkt auf den Versand (AC2)', async ({ request }) => {
    await seedReminderPref('e2e-smoke', true, ['23:00']);

    const before = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-07-20T20:30:00.000Z' }, // 22:30 CEST — before 23:00
    });
    expect((await before.json()).sent).not.toContain('e2e-smoke');

    const after = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-07-20T21:30:00.000Z' }, // 23:30 CEST — past 23:00
    });
    expect((await after.json()).sent).toContain('e2e-smoke');
    expect(await reminderSendRows('e2e-smoke')).toHaveLength(1);
  });

  test('eine zweite Zeit liefert einen zweiten, eigenen Slot — keine verschluckt die andere (AC3)', async ({
    request,
  }) => {
    await seedReminderPref('e2e-smoke', true, ['06:00', '07:00']);

    const response = await request.post('/api/push/reminders', {
      headers: { 'x-e2e-now': '2026-07-20T06:30:00.000Z' }, // 08:30 CEST — past both
    });
    const body = await response.json();

    expect((body.sent as string[]).filter((kind) => kind === 'e2e-smoke')).toHaveLength(2);
    expect(await reminderSendRows('e2e-smoke')).toHaveLength(2);
  });

  test('werden alle Zeiten entfernt, kommt nichts — die Standardzeit kehrt nicht zurück (AC4)', async ({
    request,
  }) => {
    await seedReminderPref('e2e-smoke', true, []);

    const response = await request.post('/api/push/reminders');
    const body = await response.json();

    expect(body.sent).not.toContain('e2e-smoke');
    expect(await reminderSendRows('e2e-smoke')).toHaveLength(0);
  });
});
