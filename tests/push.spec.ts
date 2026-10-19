import { expect, test, type Page } from '@playwright/test';
import { createThrowawaySession, registerPasskey, resetPushData, withDb } from './helpers';

test.beforeEach(async () => {
  await resetPushData();
});

/**
 * dev has no real service worker (Serwist is disabled outside production builds,
 * see next.config.ts), so `navigator.serviceWorker.ready`/`pushManager` are stubbed
 * here — this suite tests Subscribe→Persist→Status, not Chromium's real push stack
 * (that's push-sw.prod.spec.ts). The fake endpoint (127.0.0.1:9, the discard port)
 * fails fast and deterministically instead of depending on a real push service.
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
      value: {
        ready: Promise.resolve({ pushManager: fakePushManager }),
        getRegistration: async () => ({ pushManager: fakePushManager }),
      },
    });
  });
}

/**
 * Headless Chromium on Linux CI has no real notification service, so
 * `Notification.permission` reads 'denied' there even after
 * `context.grantPermissions(['notifications'])` — confirmed in #122 across
 * both e2e-main and e2e-offline. Stubbed here the same way `stubPushManager`
 * above stubs Chromium's push stack: this suite verifies our own
 * Subscribe→Persist→Status logic, not whether Chromium's permission prompt
 * actually works headless.
 */
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

async function pushRowCount(): Promise<number> {
  const result = await withDb((client) => client.query('SELECT endpoint FROM push_subscriptions'));
  return result.rows.length;
}

test('Aktivieren legt ein Abo an und eine Testnachricht zeigt eine Bestätigung (AC1)', async ({
  page,
}) => {
  await stubNotificationGranted(page);
  await stubPushManager(page);
  await registerPasskey(page);

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Erlauben' }).click();

  await expect(page.getByRole('button', { name: 'Senden' })).toBeVisible();
  expect(await pushRowCount()).toBe(1);

  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByText('Testnachricht gesendet.')).toBeVisible();
});

test('Abmelden entfernt das Abo serverseitig (AC2)', async ({ page }) => {
  await stubNotificationGranted(page);
  await stubPushManager(page);
  await registerPasskey(page);

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Erlauben' }).click();
  await expect(page.getByRole('button', { name: 'Senden' })).toBeVisible();
  expect(await pushRowCount()).toBe(1);

  await page.getByRole('switch', { name: 'Benachrichtigungen abschalten' }).click();

  await expect(page.getByRole('button', { name: 'Erlauben' })).toBeVisible();
  expect(await pushRowCount()).toBe(0);
});

test('App sperren entfernt das Abo des Geräts, damit die nächste Person keine fremden Erinnerungen bekommt (#1205 AC4)', async ({
  browser,
  baseURL,
}) => {
  // A throwaway session in its own context, never the shared AUTH_STATE session every
  // other project's storageState depends on (same pattern as auth-sperren.spec.ts's
  // `freshSessionContext`) — this test actually logs out, and doing that against the
  // shared session would leave every later spec in this worker signed out too (#1205,
  // quota.spec.ts's e2e-main 401s).
  const session = await createThrowawaySession();
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();

  await stubNotificationGranted(page);
  await stubPushManager(page);
  await registerPasskey(page); // short-circuits on the valid cookie, no ceremony

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'Erlauben' }).click();
  await expect(page.getByRole('button', { name: 'Senden' })).toBeVisible();
  expect(await pushRowCount()).toBe(1);

  await page.getByRole('button', { name: 'App sperren' }).click();
  await page.getByRole('button', { name: 'Sperren' }).click();

  await page.waitForURL('**/anmelden');
  expect(await pushRowCount()).toBe(0);

  await context.close();
});
