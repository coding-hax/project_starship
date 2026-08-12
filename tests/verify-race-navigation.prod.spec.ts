import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * TEMPORARY verification for issue #683 — deleted before the PR leaves draft.
 *
 * Machine load only changes the ODDS of the race that breaks AK2: whether the
 * first page's RSC prefetches are still in flight when the second navigation to
 * /uebersicht cancels them. This file forces that race instead of rolling for it,
 * by holding every RSC response back by 500ms, and then runs both wait points
 * against it:
 *
 *   ALT  — waitForLoadState('networkidle'), expected to hit the 30s budget
 *   NEU  — the named conditions from the fix, expected to pass
 *
 * The ALT test is EXPECTED TO FAIL. It is evidence, not a regression, and it
 * leaves the repo with this file.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

test.describe('race-verify', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppData();
    await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
    await registerPasskey(page);
    // Every RSC prefetch now takes at least 500ms, so the prefetches of the page
    // registerPasskey just loaded are guaranteed to be in flight when the test
    // body navigates again — the exact condition load produces by accident.
    await page.route('**/*_rsc=*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
  });

  test('ALT: networkidle laeuft in das Budget (erwarteter Fehlschlag)', async ({ page }) => {
    const started = Date.now();
    await page.goto('/uebersicht');
    await page.waitForLoadState('networkidle');
    console.log(`[RACE] ALT: Netzruhe erreicht nach ${Date.now() - started}ms`);
  });

  test('NEU: benannte Bedingungen halten', async ({ page, context }) => {
    const started = Date.now();
    const prefetched = new Set<string>();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) prefetched.clear();
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.searchParams.has('_rsc') && response.status() < 400) prefetched.add(url.pathname);
    });

    await page.goto('/uebersicht');

    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expect
      .poll(() => [...prefetched], { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['/aufgaben', '/kalender', '/routinen']));
    console.log(`[RACE] NEU: Bedingungen erfuellt nach ${Date.now() - started}ms`);

    // Drop the artificial delay before going offline, so a failure below can only
    // come from the code under test and never from this harness holding a request.
    await page.unroute('**/*_rsc=*');

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
    console.log(`[RACE] NEU: Offline-Gang komplett nach ${Date.now() - started}ms`);
  });
});
