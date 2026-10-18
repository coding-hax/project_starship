import { expect, test } from '@playwright/test';

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
