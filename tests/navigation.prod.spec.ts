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

  test('offline bleiben Übersicht, Aufgaben, Kalender und Gewohnheiten erreichbar, ohne Offline-Fallback (AK2)', async ({
    page,
    context,
  }) => {
    await page.goto('/uebersicht');
    await page.waitForLoadState('networkidle');

    await context.setOffline(true);

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const stops: Array<[label: string, heading: string]> = [
      ['Aufgaben', 'Aufgaben'],
      ['Kalender', 'Kalender'],
      ['Gewohnheiten', 'Gewohnheiten verwalten'],
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
