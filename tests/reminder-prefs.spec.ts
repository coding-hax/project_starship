import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, resetPushData, withDb } from './helpers';

/**
 * Same stubs as tests/push.spec.ts — dev has no real service worker/push stack
 * (Serwist is disabled outside production builds), so the panel's `granted` phase
 * has to be reached the same way that suite reaches it.
 */
async function stubPushManager(page: Page) {
  await page.addInitScript(() => {
    let subscription: {
      endpoint: string;
      toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
      unsubscribe: () => Promise<boolean>;
    } | null = null;

    function makeSubscription() {
      const endpoint = `https://127.0.0.1:9/e2e-fake-push/${Math.random().toString(36).slice(2)}`;
      return {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } }),
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
      };
    }

    const fakePushManager = {
      subscribe: async () => {
        subscription = makeSubscription();
        return subscription;
      },
      getSubscription: async () => subscription,
    };

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: fakePushManager }) },
    });
  });
}

async function stubNotificationGranted(page: Page) {
  await page.addInitScript(() => {
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission() {
        FakeNotification.permission = 'granted';
        return 'granted' as const;
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
  });
}

async function openPanelGranted(page: Page) {
  await stubNotificationGranted(page);
  await stubPushManager(page);
  await registerPasskey(page, '/einstellungen');
  await page.getByRole('button', { name: 'Erlauben' }).click();
  await expect(page.getByRole('button', { name: 'Senden' })).toBeVisible();
}

async function reminderPrefRow(kind: string): Promise<{ enabled: boolean; times: string[] } | null> {
  const result = await withDb((client) =>
    client.query('SELECT enabled, times FROM reminder_prefs WHERE kind = $1', [kind]),
  );
  return result.rowCount === 0 ? null : { enabled: result.rows[0].enabled, times: result.rows[0].times };
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await resetPushData();
  // The panel reads via IndexedDB (CLAUDE.md rule 8) — cutting the sync endpoints
  // proves that, same convention as habits.spec.ts/tasks.spec.ts.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
});

test('eine Erinnerungsart lässt sich einzeln abschalten, unabgeschaltete bleiben unberührt (AC1)', async ({
  page,
}) => {
  await openPanelGranted(page);

  const tasksToggle = page.getByRole('switch', { name: 'Fällige Aufgaben abschalten' });
  const habitsToggle = page.getByRole('switch', { name: 'Offene Routinen abschalten' });
  await tasksToggle.click();
  await expect(tasksToggle).toHaveAttribute('aria-checked', 'false');
  await expect(habitsToggle).toHaveAttribute('aria-checked', 'true');

  // beforeEach cuts the sync endpoints so the panel can only ever read from
  // IndexedDB — lift that to let the queued mutation actually reach Postgres,
  // same convention as the equivalent points in habits.spec.ts/tasks.spec.ts.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(async () => (await reminderPrefRow('tasks-due'))?.enabled).toBe(false);
  expect(await reminderPrefRow('habits-open')).toBeNull();
});

test('eine hinzugefügte Zeit lässt sich wieder entfernen; entfernt man alle, bleibt die Liste leer (AC4)', async ({
  page,
}) => {
  await openPanelGranted(page);
  await page.unroute('**/api/sync/**');

  await page.getByLabel('Fällige Aufgaben: neue Uhrzeit').fill('16:00');
  await page.getByRole('button', { name: 'Fällige Aufgaben: Zeit hinzufügen' }).click();
  await expect(page.getByLabel('Fällige Aufgaben: Uhrzeit 2')).toBeVisible();

  await page.getByRole('button', { name: 'Fällige Aufgaben: Uhrzeit 16:00 entfernen' }).click();
  await expect(page.getByLabel('Fällige Aufgaben: Uhrzeit 2')).toHaveCount(0);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(async () => (await reminderPrefRow('tasks-due'))?.times).toEqual(['07:00']);

  await page.getByRole('button', { name: 'Fällige Aufgaben: Uhrzeit 07:00 entfernen' }).click();
  await expect(page.getByLabel('Fällige Aufgaben: Uhrzeit 1')).toHaveCount(0);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(async () => (await reminderPrefRow('tasks-due'))?.times).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* AK: Offline anlegen -> online -> serverseitig angekommen (AC6)             */
/* -------------------------------------------------------------------------- */

test('offline geänderte Uhrzeit erreicht online die Datenbank', async ({ page, context }) => {
  await openPanelGranted(page);
  await context.setOffline(true);

  await page.getByLabel('Fällige Aufgaben: Uhrzeit 1').fill('16:00');
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Order matters — see the equivalent comment in habits.spec.ts (#120): the app's
  // own 'online' listener fires an automatic sync() the instant we go online, and
  // unrouting after that races its in-flight request against the teardown.
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
  await expect.poll(async () => (await reminderPrefRow('tasks-due'))?.times).toEqual(['16:00']);
});
