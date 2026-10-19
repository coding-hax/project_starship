import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

test('Bewegung reduzieren schaltet den Toggle und bleibt nach Reload erhalten', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Bewegung reduzieren' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
});

test('SegmentedControl wählt das Theme, setzt es auf <html> und reagiert auf Pfeiltasten', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const dunkel = page.getByRole('radio', { name: 'Dunkel' });
  await dunkel.click();
  await expect(dunkel).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dunkel');
  const bgDark = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg'),
  );

  const hell = page.getByRole('radio', { name: 'Hell' });
  await hell.click();
  await expect(hell).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'hell');
  const bgLight = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg'),
  );
  expect(bgLight).not.toBe(bgDark);

  await hell.focus();
  await page.keyboard.press('ArrowRight');
  const dunkelAgain = page.getByRole('radio', { name: 'Dunkel' });
  await expect(dunkelAgain).toBeFocused();
  await expect(dunkelAgain).toHaveAttribute('aria-checked', 'true');
});

/* -------------------------------------------------------------------------- */
/* issue #660: Kategoriefarben selbst wählen                                  */
/* -------------------------------------------------------------------------- */

function categoryColorsPanel(page: Page) {
  return page.locator('.section-card').filter({ has: page.getByRole('heading', { name: 'Kategoriefarben', level: 2 } ) });
}

function categoryRow(page: Page, label: string) {
  return categoryColorsPanel(page)
    .locator('.category-colors-panel__category')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** The row's own `<button>` — tap target that opens/closes its swatch grid (issue #858). */
function categoryRowToggle(page: Page, label: string) {
  return categoryRow(page, label).locator('.category-colors-panel__row');
}

async function categoryColorFromDb(category: string): Promise<string | null> {
  // deleted_at IS NULL: reset() soft-deletes (push/route.ts), it does not clear
  // `color` (NOT NULL column) — the row's last color survives the tombstone, so a
  // query without this filter would see the stale value instead of "no override"
  // (same convention as journal.spec.ts/offline-critical.spec.ts).
  const result = await withDb((client) =>
    client.query('SELECT color FROM category_colors WHERE category = $1 AND deleted_at IS NULL', [category]),
  );
  return result.rowCount === 0 ? null : (result.rows[0].color as string);
}

test.describe('Kategoriefarben (issue #660)', () => {
  test.beforeEach(async ({ page }) => {
    // Das Panel liest ausschließlich aus IndexedDB (CLAUDE.md Regel 8) — Sync
    // gekappt beweist das, gleiche Konvention wie reminder-prefs.spec.ts.
    await page.route('**/api/sync/**', (route) => route.abort('failed'));
  });

  test('AK6: ein Reset-Weg führt je Kategorie zurück auf den Default', async ({ page }) => {
    await registerPasskey(page, '/einstellungen');

    const arbeitRow = categoryRow(page, 'Arbeit');
    await categoryRowToggle(page, 'Arbeit').click();
    await arbeitRow.getByRole('radio', { name: 'Arbeit: Bernstein' }).click();
    const resetButton = arbeitRow.getByRole('button', { name: 'Arbeit: Standardfarbe verwenden' });
    await expect(resetButton).toBeVisible();

    await resetButton.click();
    await expect(arbeitRow.getByRole('radio', { name: 'Arbeit: Bernstein' })).not.toBeChecked();
    await expect(resetButton).toHaveCount(0);

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => categoryColorFromDb('arbeit')).toBeNull();
  });

  test('AK9: offline gewählte Kategoriefarbe erreicht online die Datenbank', async ({ page, context }) => {
    await registerPasskey(page, '/einstellungen');
    await context.setOffline(true);

    await categoryRowToggle(page, 'Familie').click();
    await categoryRow(page, 'Familie').getByRole('radio', { name: 'Familie: Rosé' }).click();
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

    // Reihenfolge wie in habits.spec.ts/reminder-prefs.spec.ts: erst entrouten,
    // dann online — sonst wettläuft der App-eigene 'online'-Listener gegen das Unroute.
    await page.unroute('**/api/sync/**');
    await context.setOffline(false);
    await page.evaluate(() => window.__starship.sync());

    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
    await expect.poll(() => categoryColorFromDb('familie')).toBe('--swatch-rose');
  });
});
