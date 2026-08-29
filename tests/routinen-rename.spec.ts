import { expect, test, type Page } from '@playwright/test';

/**
 * "Gewohnheiten" was renamed to "Routinen" (issue #655) — 12 characters was the one
 * label that would not fit a bottom-nav slot, see shell.css `.nav__item`.
 *
 * The rename moved three things that happen to share a word: the visible label, the
 * route, and the module id. Only the first is cosmetic. The other two are covered
 * here, because each has a way of failing silently:
 *
 *  - the route is listed in `middleware.ts`'s matcher, and a matcher that still names
 *    the old path leaves the new one reachable **without a session**;
 *  - the module id keys two localStorage lists whose readers ignore ids they do not
 *    know, so a rename without `LEGACY_MODULE_IDS` loses a saved nav position and
 *    switches a disabled module back on — neither throws, both just quietly differ.
 *
 * The mapping itself is unit-tested in `src/modules/module-ids.test.ts`; what these
 * tests add is that it is actually wired into both readers *and* the pre-paint script.
 */

const ORDER_KEY = 'starship:nav-order';
const MODULES_OFF_KEY = 'starship:modules-off';

/** Writes a device-local list and reloads, so the store reads it on a cold boot. */
async function seedStoredList(page: Page, key: string, value: string[]): Promise<void> {
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key, value },
  );
  await page.reload();
}

test('der Tab heißt „Routinen" und die Seite trägt dieselbe Überschrift (AC1)', async ({ page }) => {
  await page.goto('/routinen');

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link', { name: 'Routinen' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Gewohnheiten' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Routinen', level: 1 })).toBeVisible();
});

test('/gewohnheiten leitet dauerhaft auf /routinen (AC2)', async ({ page }) => {
  await page.goto('/gewohnheiten');

  await expect(page).toHaveURL(/\/routinen$/);
  await expect(page.getByRole('heading', { name: 'Routinen', level: 1 })).toBeVisible();
});

test('/heute/gewohnheiten landet direkt auf /routinen, ohne Zwischenstopp (AC2)', async ({ page }) => {
  // Points at the current route in one hop rather than chaining through
  // /gewohnheiten: each permanent redirect is a cached 308, and the intermediate one
  // is exactly what an old service worker may still hold.
  const response = await page.goto('/heute/gewohnheiten');

  await expect(page).toHaveURL(/\/routinen$/);
  expect(response?.request().redirectedFrom()?.url()).toContain('/heute/gewohnheiten');
});

test.describe('ohne Session-Cookie', () => {
  // Opts out of the shared owner session the `setup` project hands to every other
  // project (#115) — this test is specifically about having none.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/routinen ohne Session landet auf /anmelden — der Matcher ist mitgezogen (AC3)', async ({
    page,
  }) => {
    await page.goto('/routinen');

    await expect(page).toHaveURL(/\/anmelden$/);
    await expect(page.locator('.shell')).toHaveCount(0);
  });
});

test('eine gespeicherte Nav-Reihenfolge mit der Alt-ID behält ihre Position (AC4)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });

  // Second slot — the position a dropped id would lose, since resolveOrder() appends
  // what it cannot match at the *end*.
  await seedStoredList(page, ORDER_KEY, [
    'uebersicht',
    'gewohnheiten',
    'aufgaben',
    'kalender',
    'journal',
    'aktivitaeten',
  ]);

  const labels = await nav.locator('.nav__label').allInnerTexts();
  expect(labels).toEqual(['Übersicht', 'Routinen', 'Aufgaben', 'Kalender', 'Journal', 'Aktivitäten']);
});

test('ein unter der Alt-ID abgeschaltetes Modul bleibt abgeschaltet (AC5)', async ({ page }) => {
  await page.goto('/uebersicht');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link', { name: 'Routinen' })).toBeVisible();

  await seedStoredList(page, MODULES_OFF_KEY, ['gewohnheiten']);

  // An exclusion list that stops matching does not fail loudly — it switches the
  // module back **on**, which is why this asserts the tab is gone rather than present.
  await expect(nav.getByRole('link', { name: 'Routinen' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Routinen', level: 2 })).toHaveCount(0);

  // And the settings switch — where it actually lives — reflects the same stored
  // state, rather than the module merely being hidden somewhere downstream.
  await page.goto('/einstellungen');
  await expect(page.getByRole('switch', { name: 'Routinen' })).not.toBeChecked();
});

test('die Alt-ID wirkt schon vor dem ersten Paint, das Modul blitzt nicht auf (AC5)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(
    ({ key }) => localStorage.setItem(key, JSON.stringify(['gewohnheiten'])),
    { key: MODULES_OFF_KEY },
  );

  // Blocks every script *resource* — the page never hydrates, so the client-side guard
  // (module-route-guard.tsx) cannot run. The root layout's bootstrap is inline in the
  // HTML, not a resource, so it still executes: what is left is exactly the pre-paint
  // mechanism (data-modules-off + globals.css), isolated from React entirely. Same
  // approach as the `journal` case in modules.spec.ts.
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'script' ? route.abort() : route.continue(),
  );

  await page.goto('/routinen');

  const wrapper = page.locator('[data-module="routinen"]');
  await expect(wrapper).toBeAttached();
  await expect(wrapper).toBeHidden();
});
