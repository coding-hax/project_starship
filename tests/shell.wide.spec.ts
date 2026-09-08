import { expect, test } from '@playwright/test';
import { registerPasskey } from './helpers';

/**
 * Rauchtest für den neuen `desktop-wide`-Messplatz (1800 × 1000, issue #1115):
 * belegt nur, dass er überhaupt lädt und nicht querläuft. Die Dreispalten-
 * Anordnung selbst prüft das folgende Ticket (#1113).
 */

test('/uebersicht lädt bei 1800px ohne horizontalen Scrollbalken (issue #1115)', async ({ page }) => {
  await registerPasskey(page, '/uebersicht');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(1800);
});
