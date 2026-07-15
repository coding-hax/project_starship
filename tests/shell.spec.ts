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

test('the navigation sits where its layout puts it: bottom bar on mobile, left sidebar on desktop', async ({
  page,
}, testInfo) => {
  await registerPasskey(page);

  const viewport = page.viewportSize();
  const navBox = await page.getByRole('navigation', { name: 'Hauptnavigation' }).boundingBox();
  const mainBox = await page.locator('main.shell__main').boundingBox();
  expect(viewport).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  if (testInfo.project.name === 'mobile') {
    // Bottom bar: its bottom edge reaches the viewport bottom, not sitting under the status bar,
    // with the content above it and no dead space at the top.
    expect(navBox!.y + navBox!.height).toBeGreaterThan(viewport!.height - 2);
    expect(mainBox!.y).toBeLessThan(navBox!.y);
    expect(mainBox!.y).toBeLessThan(viewport!.height / 2);
  } else {
    // Sidebar: full-height, hugging the left edge, with the content to its right.
    expect(navBox!.x).toBeLessThan(2);
    expect(navBox!.height).toBeGreaterThan(viewport!.height - 2);
    expect(mainBox!.x).toBeGreaterThan(navBox!.x + navBox!.width - 2);
  }
});
