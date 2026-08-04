import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

/**
 * Fund F23 (#497): every other prod-build spec runs against a build with
 * `NEXT_PUBLIC_E2E=1` (playwright.config.ts), which inlines E2E-only branches — the
 * service worker (src/app/sw.ts) and the E2E bridge (src/app/(app)/layout.tsx) — that
 * tree-shake out of the real bundle. Nothing proved the branch that actually ships
 * still boots. This spec runs against `playwright.shipped.config.ts`, a build WITHOUT
 * the flag, so it has no `window.__starship` and no `x-e2e-now` to reach for (AK4) —
 * everything below goes through the real UI, the real service worker, and Postgres.
 *
 * No `storageState` project here (own config, see playwright.shipped.config.ts): the
 * shared AUTH_STATE was captured against the E2E-flagged build's origin/port and does
 * not apply. `registerPasskey` runs the full ceremony every time instead.
 */
test.beforeEach(async ({ page }) => {
  await resetDatabase();
  await registerPasskey(page);
  await page.goto('/aufgaben');
});

test('Ausgeliefertes Bündel: Anmeldung mit Passkey → offline Hülle nach Reload → online synchronisiert', async ({
  page,
  context,
}) => {
  // Anmeldung mit Passkey (AK2, Teil 1) ist bereits durch registerPasskey() in
  // beforeEach gelaufen — die volle WebAuthn-Zeremonie gegen das ausgelieferte Bündel.

  // Der echte Service Worker aus dem ausgelieferten Build kontrolliert die Seite —
  // dieselbe reload-nach-ready-Begründung wie in offline-critical.spec.ts.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);

  const title = 'Im ausgelieferten Bündel notiert';
  await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
  await page.getByRole('textbox', { name: 'Titel der Aufgabe' }).fill(title);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.getByText(title)).toBeVisible();

  // Offline-Hülle nach Reload (AK2, Teil 2): App-Shell aus dem SW-Precache, die
  // Aufgabe aus IndexedDB — beides ohne Netz.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Aufgaben', level: 1 })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();

  // Wieder online synchronisiert (AK2, Teil 3): kein window.__starship.sync() (AK4) —
  // startSync() (src/local/sync.ts) feuert beim Neu-Mount nach dem Reload von selbst.
  await context.setOffline(false);
  await page.reload();

  await expect
    .poll(() => withDb((client) => client.query('SELECT title FROM tasks WHERE title = $1', [title])).then((r) => r.rows.length))
    .toBe(1);
});
