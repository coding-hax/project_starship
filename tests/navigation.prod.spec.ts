import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Issue #599: the (app) segment is statically prerendered now that the auth gate
 * lives in middleware.ts (cookie presence only) instead of an `await getSession()`
 * in the layout. That only actually holds against the production build — the dev
 * server never prerenders and always speaks RSC per request — so this spec runs
 * against the prod-build projects (offline-mobile/offline-desktop, see
 * playwright.config.ts), same as offline-critical.spec.ts.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

test.describe('angemeldet', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppData();
    // The overview mounts the weather module (src/modules/registry.ts), which fires a
    // real request against open-meteo. Left unrouted it never settles on a CI runner,
    // so the `networkidle` waits below can never be reached — the same mock every
    // other spec touching /uebersicht already installs (issue #613). The forecast
    // itself is irrelevant here, so failing it outright is enough.
    await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
    await registerPasskey(page);
  });

  test('ein Tab-Wechsel zum Kalender geht ohne Dokument- oder RSC-Request an den Server (AK1)', async ({
    page,
  }) => {
    // Registered before goto() so it also catches the Link prefetch itself — that
    // fetch is expected (it is what makes the later click free) and must not be
    // mistaken for one the click caused.
    const kalenderRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const isRscRequest = url.searchParams.has('_rsc') && url.pathname === '/kalender';
      const isDocumentNavigation = request.resourceType() === 'document' && url.pathname === '/kalender';
      if (isRscRequest || isDocumentNavigation) kalenderRequests.push(request.url());
    });

    await page.goto('/uebersicht');
    await page.waitForLoadState('networkidle');

    // `networkidle` only proves no request is in flight, not that the Kalender
    // link's own prefetch has actually gone out yet — that fires from a
    // post-hydration router effect, which a loaded CI runner can delay past the
    // networkidle window. Wait for the real signal (bounded, so a genuinely
    // missing prefetch still fails the assertion below instead of hanging).
    if (kalenderRequests.length === 0) {
      await page
        .waitForRequest(
          (request) => {
            const url = new URL(request.url());
            return url.pathname === '/kalender' && url.searchParams.has('_rsc');
          },
          { timeout: 15_000 },
        )
        .catch(() => {});
    }

    // The prefetch (if any) already happened above — only what the click itself
    // triggers from here on counts towards the assertion.
    kalenderRequests.length = 0;

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await nav.getByRole('link', { name: 'Kalender' }).click();

    await expect(page.locator('[data-module="kalender"]')).toBeVisible();
    await expect(page.getByText('Keine Termine an diesem Tag.')).toBeVisible();

    expect(kalenderRequests).toEqual([]);
  });

  test('offline bleiben Übersicht, Aufgaben, Kalender und Routinen erreichbar, ohne Offline-Fallback (AK2)', async ({
    page,
    context,
  }) => {
    // The RSC prefetches the nav fires after hydration are what makes the offline
    // clicks below free: Next serves those routes from its in-memory router cache.
    // They are NOT in the service worker's Cache Storage — that holds only the
    // precached shell (verified in #683) — so there is nothing to read back from
    // `caches` here.
    const prefetched = new Set<string>();
    // Cleared on every main-frame navigation, and that is the whole point: a
    // prefetch belongs to ONE document. `registerPasskey` already loaded
    // /uebersicht, so the goto below replaces that page and throws its router cache
    // away with it. Counting the prefetches of the replaced page would satisfy this
    // wait while the current page still has nothing cached — the same class of
    // false signal as `networkidle`, only quieter. `framenavigated` commits before
    // the new document fetches anything, so everything counted after it is the
    // current page's.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) prefetched.clear();
    });
    // `requestfinished`, not `response`: the latter fires on the response HEADERS,
    // so the wait below could pass while the payload was still in flight and the
    // `setOffline` right after would cut it off mid-body, leaving the router cache
    // incomplete. Cancelled prefetches reach neither handler, which is exactly what
    // must not count.
    page.on('requestfinished', (request) => {
      const url = new URL(request.url());
      if (!url.searchParams.has('_rsc')) return;
      void request
        .response()
        .then((response) => {
          // `status < 400` rather than `ok()`: the (app) segment is statically
          // prerendered (#599), so a navigation can revalidate a prefetch it
          // already holds and get a 304 — `ok()` is false for that, while the
          // router does have the payload.
          if (response && response.status() < 400) prefetched.add(url.pathname);
        })
        .catch(() => {});
    });

    await page.goto('/uebersicht');

    // Deliberately NOT `networkidle` (#683). `registerPasskey` already left the page
    // on a loaded /uebersicht, so the goto above is the SECOND navigation to it and
    // cancels the first page's in-flight prefetches. A cancelled request never
    // leaves Playwright's bookkeeping of open connections, so `networkidle` waited
    // for a quiet state that could no longer occur and burned the whole 30s budget.
    // It is bimodal, not slow: 1.9s or 30s, nothing in between. `offline-desktop` is
    // hit and `offline-mobile` is not because 1280px shows more nav targets at once,
    // so more prefetches are in flight for that second navigation to cancel.
    //
    // What the walk below actually needs, as three named conditions:
    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    // A service worker that is not merely active but serving THIS page — offline,
    // every asset the walk needs comes out of its precache. `ready` alone only
    // proves a worker is active: `clientsClaim` (src/app/sw.ts) claims existing
    // clients once activation finishes, which races with the navigation that
    // triggered the registration, so reading `controller` right after `ready` found
    // it null in 1 of 21 runs. Waiting for the claim is enough — and unlike a
    // reload (the route offline-critical.spec.ts takes, to prove serving from the
    // precache) it does not throw away the router cache the walk below depends on.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 })
      .toBe(true);
    // And the payload of every route visited offline below, in the router cache.
    // Bounded, like the prefetch wait in AK1 above: a prefetch that genuinely never
    // arrives has to fail the test, not hang it.
    await expect
      .poll(() => [...prefetched], { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['/aufgaben', '/kalender', '/routinen']));

    await context.setOffline(true);

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const stops: Array<[label: string, heading: string]> = [
      ['Aufgaben', 'Aufgaben'],
      ['Kalender', 'Kalender'],
      ['Routinen', 'Routinen verwalten'],
      ['Übersicht', 'Übersicht'],
    ];

    for (const [label, heading] of stops) {
      await nav.getByRole('link', { name: label }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page).not.toHaveURL(/\/offline$/);
    }
  });
});

test.describe('ohne Session-Cookie', () => {
  // Opts out of the shared owner session the `setup` project hands to every other
  // project (#115) — this test is specifically about having none.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('ein direkter Aufruf von /kalender landet auf /anmelden, ohne die Shell zu zeigen (AK3)', async ({
    page,
  }) => {
    await page.goto('/kalender');

    await expect(page).toHaveURL(/\/anmelden$/);
    await expect(page.locator('.shell')).toHaveCount(0);
  });
});

test('ein ungültiges Session-Cookie kommt an der Middleware vorbei, wird aber beim ersten Sync-Pull mit 401 abgewiesen und nach /anmelden geleitet (AK4)', async ({
  browser,
  baseURL,
}) => {
  // A deliberately isolated context, not the shared AUTH_STATE session (memory:
  // parallel E2E runs share one Postgres — writing into the shared session's
  // cookie jar here would risk stepping on another run's device).
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addCookies([
    {
      name: 'starship_session',
      value: `invalid-${randomUUID()}`,
      url: baseURL,
    },
  ]);

  await page.goto('/kalender');

  // Middleware only checks presence, so it lets this through — the shell mounts
  // and starts syncing before the first pull's 401 kicks it back out.
  await expect(page.locator('.shell')).toBeVisible();
  await page.waitForURL('**/anmelden');

  await context.close();
});
