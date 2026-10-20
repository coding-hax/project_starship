import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * #1224 AK8 — runs only against the prod-build projects (offline-mobile/
 * offline-desktop, see playwright.config.ts): Serwist is disabled in dev
 * (next.config.ts), so there is no real service worker to drive there, and
 * `defaultCache`'s `NetworkFirst` entries that would otherwise cache
 * `/api/*` GETs for 24h only exist in that production build too (dev's
 * `defaultCache` is a single blanket `NetworkOnly`). The page's own
 * `Cache-Control: no-store` header lives here for the same reason: Next's dev
 * server unconditionally overwrites a page response's `Cache-Control` with
 * `no-cache, must-revalidate` (`base-server.js`, dev-only), so the real header
 * middleware.ts sets only ever survives in a production build.
 */
test.beforeEach(async ({ page }) => {
  await resetAppData();
  // A real target, not `null` — `registerPasskey` only skips its own
  // navigation when already authenticated, which leaves the page on
  // `about:blank` with no `navigator.serviceWorker` to wait on below.
  await registerPasskey(page, '/uebersicht');
  // `ready` only proves a worker is active, not that it controls THIS page
  // (clientsClaim races the first navigation) — a reload after `ready` is
  // always served by the already-active worker (Memory
  // "sw-controller-braucht-reload-nach-ready").
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
});

test('/admin und /api/admin/accounts tragen no-store und landen nie im Cache Storage', async ({ page }) => {
  const pageResponse = await page.goto('/admin');
  expect(pageResponse?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { name: 'Verwaltung', level: 1 })).toBeVisible();

  const cachedAdminPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const hits: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      for (const request of requests) {
        const path = new URL(request.url).pathname;
        if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/')) {
          hits.push(path);
        }
      }
    }
    return hits;
  });

  expect(cachedAdminPaths).toEqual([]);
});
