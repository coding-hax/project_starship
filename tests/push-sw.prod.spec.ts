import { expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { registerPasskey, resetPushData } from './helpers';

/**
 * Runs only against the prod-build projects (offline-mobile/offline-desktop, see
 * playwright.config.ts) — Serwist is disabled in dev (next.config.ts), so there is
 * no real service worker to drive there. push.spec.ts covers Subscribe→Persist→
 * Status against a stubbed pushManager instead.
 *
 * Drives the actual service worker via `self.__pushTest`/`self.__simulateNotificationClick`
 * (src/app/sw.ts, gated behind NEXT_PUBLIC_E2E) rather than a real push service —
 * there is no way to make Google/Mozilla/Apple's push infrastructure deliver to a
 * headless test run, and that isn't what this ticket needs to prove: the handler
 * logic itself (build a visible notification, open the app on tap) is what's under
 * test, not third-party delivery.
 *
 * Headless Chromium on Linux CI additionally has no real notification service, so
 * `self.registration.showNotification()`/a real `Notification` instance are never
 * available even after `context.grantPermissions(['notifications'])` (confirmed in
 * #122). Both tests below therefore assert against the E2E-only recording hooks in
 * src/app/sw.ts instead of `registration.getNotifications()`.
 */
test.beforeEach(async ({ page }) => {
  await resetPushData();
  await registerPasskey(page, '/uebersicht');
  await page.evaluate(() => navigator.serviceWorker.ready);
});

async function getServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) return existing[0];
  return context.waitForEvent('serviceworker');
}

test('ein Push zeigt eine sichtbare Benachrichtigung (AC1)', async ({ context }) => {
  const worker = await getServiceWorker(context);

  await worker.evaluate(async () => {
    const scope = self as unknown as {
      __pushTest: (data: unknown) => Promise<void>;
    };
    await scope.__pushTest({ title: 'Starship', body: 'Testnachricht', url: '/' });
  });

  await expect
    .poll(() =>
      worker.evaluate(
        () =>
          (self as unknown as { __e2eShownNotifications?: unknown[] }).__e2eShownNotifications
            ?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
});

test('Tippen auf die Benachrichtigung öffnet die App (AC1)', async ({ context }) => {
  const worker = await getServiceWorker(context);

  await worker.evaluate(async () => {
    const scope = self as unknown as {
      __simulateNotificationClick: (url: string) => Promise<void>;
    };
    await scope.__simulateNotificationClick('/');
  });

  await expect
    .poll(() =>
      worker.evaluate(
        () => (self as unknown as { __lastNotificationClick?: string }).__lastNotificationClick,
      ),
    )
    .toBe('/');
});
