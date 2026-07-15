import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

test.beforeEach(async () => {
  await resetDatabase();
});

test('an unauthenticated visitor is sent to the login', async ({ page }) => {
  await page.goto('/heute');
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(page.getByRole('button', { name: 'Passkey einrichten' })).toBeVisible();
});

test('passkey setup issues a recovery code exactly once and opens the app', async ({ page }) => {
  await registerPasskey(page);
  await expect(page.getByRole('heading', { name: 'Heute', level: 1 })).toBeVisible();

  // Second visit: already authenticated, so no code and no second setup.
  await page.goto('/anmelden');
  await expect(page).toHaveURL(/\/heute$/);
  await expect(page.getByTestId('recovery-code')).toHaveCount(0);
});

test('all four tabs are reachable', async ({ page }) => {
  await registerPasskey(page);

  for (const [label, path] of [
    ['Aufgaben', '/aufgaben'],
    ['Kalender', '/kalender'],
    ['Journal', '/journal'],
    ['Heute', '/heute'],
  ] as const) {
    await page.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: label, level: 1 })).toBeVisible();
  }
});

test('the navigation marks the current tab', async ({ page }) => {
  await registerPasskey(page);
  await page.getByRole('link', { name: 'Journal' }).click();

  await expect(page.getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Aufgaben' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the bottom nav sits at the bottom edge of the viewport on mobile', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'nav is a sidebar on desktop, not a bottom bar');
  await registerPasskey(page);

  const viewport = page.viewportSize();
  const navBox = await page.getByRole('navigation', { name: 'Hauptnavigation' }).boundingBox();
  const mainBox = await page.locator('main.shell__main').boundingBox();
  expect(viewport).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  // The nav's bottom edge must reach the bottom of the viewport, not sit under the status bar.
  expect(navBox!.y + navBox!.height).toBeGreaterThan(viewport!.height - 2);
  // Main content starts above the nav, with no dead space between them and the top.
  expect(mainBox!.y).toBeLessThan(navBox!.y);
  expect(mainBox!.y).toBeLessThan(viewport!.height / 2);
});
