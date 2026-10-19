import { expect, test } from '@playwright/test';
import { expectUebersichtLoaded, registerPasskey, resetDatabase } from './helpers';

// Drives the auth UI itself and asserts the never-registered state, so it opts out of
// the shared owner session and keeps the full reset (#115).
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  await resetDatabase();
});

test('an unauthenticated visitor is sent to the login', async ({ page }) => {
  await page.goto('/uebersicht');
  await expect(page).toHaveURL(/\/anmelden$/);
  // No self-service setup any more (#1202, AK5) — an empty installation points at
  // the invite link instead of offering a button of its own.
  await expect(page.getByText('Diese App ist nur über einen Einladungs-Link erreichbar.')).toBeVisible();
});

test('passkey setup issues a recovery code exactly once and opens the app', async ({ page }) => {
  await registerPasskey(page);
  await expectUebersichtLoaded(page);

  // Second visit: already authenticated, so no code and no second setup.
  await page.goto('/anmelden');
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByTestId('recovery-code')).toHaveCount(0);
});

test('all six tabs are reachable and mark themselves current (issue #123 AC1, #180)', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const [label, path, heading] of [
    ['Aufgaben', '/aufgaben', 'Aufgaben'],
    ['Routinen', '/routinen', 'Routinen'],
    // Titel „Diese Woche" seit issue #898 — der Nav-Tab heißt weiterhin „Kalender".
    ['Kalender', '/kalender', 'Diese Woche'],
    ['Journal', '/journal', 'Wie war dein Tag?'],
    // Übersicht's heading is a time-of-day greeting (issue #862), not a fixed
    // string — checked below via expectUebersichtLoaded instead.
    ['Übersicht', '/uebersicht', null],
  ] as const) {
    await page.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    if (heading === null) {
      await expectUebersichtLoaded(page);
    } else {
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
  }
});
