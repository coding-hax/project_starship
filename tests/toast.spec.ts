import { expect, test, type Page } from '@playwright/test';
import { resetAppData, selectView } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

/** Mirrors sync.spec.ts AC2 — five failed pushes in a row cross SYNC_ERROR_THRESHOLD
 * and surface the sticky error toast via sync-status.tsx. Seit #797 der einzige
 * verbleibende Toast im Produkt. */
async function triggerSyncErrorToast(page: Page) {
  await page.route('**/api/sync/push', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.evaluate(() =>
    window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Bleibt hängen' } }),
  );
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__starship.sync());
  }
}

test('AC4: der Fehler-Toast verschwindet automatisch, sobald der Sync-Fehler behoben ist', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await selectView(page, 'Alle');

  await triggerSyncErrorToast(page);
  await expect(page.locator('.toast--error')).toBeVisible();

  // Kein Klick auf „Schließen" — sync-status.tsx räumt sich selbst ab, sobald
  // `overSyncErrorThreshold` wieder falsch wird (die einzige verbliebene Form
  // von „automatisch abräumen", seit der zeitgesteuerte Undo-Toast weg ist).
  await page.unroute('**/api/sync/push');
  await page.evaluate(() => window.__starship.sync());

  await expect(page.locator('.toast--error')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
});
