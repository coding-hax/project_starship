import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

/**
 * The one spec that proves the full offline round-trip (issue #57): a real service
 * worker, not just a DOM that happens to render. Runs only against the prod-build
 * projects (offline-mobile/offline-desktop, see playwright.config.ts) — the dev
 * server never ships a service worker (next.config.ts: `disable: NODE_ENV ===
 * 'development'`).
 *
 * Unlike tasks.spec.ts, this test does not cut `/api/sync/**` in beforeEach — the
 * whole point is watching the round trip actually reach Postgres.
 */
test.beforeEach(async ({ page }) => {
  await resetDatabase();
  await registerPasskey(page);
  await page.goto('/aufgaben');
});

test('Service Worker → IndexedDB → Outbox → Postgres im geschlossenen Kreis', async ({
  page,
  context,
}) => {
  // 1. Service Worker aktiv? Nicht nur DOM da — `ready` allein beweist noch nicht,
  // dass dieser Client von ihm kontrolliert wird (clientsClaim/skipWaiting, src/app/sw.ts).
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  // 2. Offline.
  await context.setOffline(true);

  // 3. Task über die echte UI anlegen — der kritische Nutzerpfad, keine Bridge.
  const title = 'Im Tunnel notiert';
  await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
  await page.getByRole('textbox', { name: 'Titel der Aufgabe' }).fill(title);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByText(title)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Stärkung: die App-Shell kommt offline weiter — aus dem Precache des Service
  // Workers, nicht vom Netz — und der Task bleibt sichtbar (aus IndexedDB).
  await page.reload();
  await expect(page.getByText(title)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // 4. Online.
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  // 5. Landet der Eintrag in Postgres? Outbox leer?
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows).toHaveLength(1);
});
