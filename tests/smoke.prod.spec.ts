import { expect, test } from '@playwright/test';

/**
 * Read-only post-deploy smoke (#56). Runs against `SMOKE_URL` in production, and
 * against the normal local `baseURL` as part of the regular `pnpm e2e` suite — same
 * spec, no separate thing to keep green. It is the real single-user prod DB, so:
 * no login, no mutation, ever.
 */

test('the shell renders a login or setup screen without a session', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/anmelden$/);
  await expect(page.getByRole('heading', { name: 'Starship', level: 1 })).toBeVisible();

  // Prod already has a passkey registered ("login"); a fresh local/CI database does
  // not yet ("setup") — either is proof the shell and /api/auth/status render fine.
  const loginButton = page.getByRole('button', { name: 'Mit Passkey anmelden' });
  const setupButton = page.getByRole('button', { name: 'Passkey einrichten' });
  await expect(loginButton.or(setupButton)).toBeVisible();
});

test('the service worker is reachable', async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/sw.js`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('javascript');
});
