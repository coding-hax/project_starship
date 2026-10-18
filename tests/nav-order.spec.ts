import { expect, test } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

/**
 * Everything here holds in both layouts (mobile and desktop project) — the settings
 * panel and the stored order are the same regardless of viewport. Assertions that
 * only hold in one layout live in nav-order.mobile.spec.ts / nav-order.desktop.spec.ts
 * instead of a runtime `test.skip` here, which `test-integrity` rejects on sight
 * (see shell.mobile.spec.ts for why).
 */

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test.describe('Reihenfolge in den Einstellungen (issue #205 AC3)', () => {
  test('eine geänderte Reihenfolge wirkt sofort in der Nav und übersteht einen Reload', async ({ page }) => {
    await page.goto('/einstellungen');
    await expect(page.getByRole('heading', { name: 'Reihenfolge der Navigation' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const firstLabelBefore = NAV_ITEMS[0].label;
    const secondLabelBefore = NAV_ITEMS[1].label;
    await expect(nav.locator('.nav__label').first()).toHaveText(firstLabelBefore);

    await page.getByRole('button', { name: `${secondLabelBefore} nach oben` }).click();
    await expect(nav.locator('.nav__label').first()).toHaveText(secondLabelBefore);

    await page.reload();
    await expect(nav.locator('.nav__label').first()).toHaveText(secondLabelBefore);
  });
});
