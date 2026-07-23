import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

/**
 * Shell assertions that only hold in the desktop layout — see shell.mobile.spec.ts
 * for why these live in their own file instead of behind a runtime `test.skip`.
 */

// Drives the auth UI itself and asserts the never-registered state, so it opts out of
// the shared owner session and keeps the full reset (#115).
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  await resetDatabase();
});

test('Einstellungen is reachable from the header and keeps its active state (issue #123 AC5)', async ({
  page,
}) => {
  // Desktop-only since #126: the sidebar carries the link across navigation, so it is
  // still there to assert against after landing on /einstellungen. On mobile the entry
  // point is scoped to /heute and disappears — covered by the #126 AC1+AC2 test instead.
  await registerPasskey(page);

  const settings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(settings).not.toHaveAttribute('aria-current', 'page');
  await settings.click();
  await expect(page).toHaveURL(/\/einstellungen$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');
});

test('the settings entry point stays reachable from every screen via the sidebar, active state intact (issue #126 AC3+AC4)', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const path of ['/heute', '/aufgaben', '/gewohnheiten', '/kalender', '/journal']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible();
  }

  const settings = page.getByRole('link', { name: 'Einstellungen' });
  await settings.click();
  await expect(page).toHaveURL(/\/einstellungen$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');
});

test('auf /heute rutscht der Inhalt bei 1280px nicht unter die Kopfzeile der Shell (issue #137 AC6)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/heute');

  const header = page.locator('.app-header--chrome');
  const main = page.locator('main.shell__main');
  const [headerBox, mainBox] = await Promise.all([header.boundingBox(), main.boundingBox()]);
  expect(headerBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(mainBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
});
