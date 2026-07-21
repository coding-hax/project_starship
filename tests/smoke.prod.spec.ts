import { expect, test } from '@playwright/test';

// Asserts the *signed-out* shell, so it opts out of the shared owner session that the
// `setup` project hands to every other project (#115).
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Read-only post-deploy smoke (#56). Runs against `SMOKE_URL` in production, and
 * locally as part of `pnpm e2e` — same spec, no separate thing to keep green. It is
 * the real single-user prod DB, so: no login, no mutation, ever.
 *
 * Locally it runs in the `offline-*` projects, i.e. against the production-build
 * server, because `/sw.js` only exists in a production build (#115). It used to run
 * against the dev server and passed only because an earlier `pnpm build` had left
 * `public/sw.js` behind for it to serve — accidental, not real coverage.
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
