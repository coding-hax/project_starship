import { expect, test } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

const ORDER_KEY = 'starship:nav-order';

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

  test('der oberste Eintrag hat keinen Nach-oben-, der unterste keinen Nach-unten-Knopf', async ({ page }) => {
    await page.goto('/einstellungen');

    await expect(page.getByRole('button', { name: `${NAV_ITEMS[0].label} nach oben` })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: `${NAV_ITEMS[NAV_ITEMS.length - 1].label} nach unten` }),
    ).toBeDisabled();
  });
});

test.describe('gespeicherte Reihenfolge über Änderungen an den Einträgen hinweg (issue #205 AC4)', () => {
  test('ein unbekannter Eintrag wird ignoriert, ein fehlender erscheint hinten statt zu verschwinden', async ({
    page,
  }) => {
    // Stands in for #180 adding a sixth entry: "journal"/"aufgaben" are known and
    // reordered, "ghost-tab" is a stale id from a removed entry, and the other three
    // known ids are simply missing from what was ever stored.
    await page.evaluate(
      ({ key, order }) => localStorage.setItem(key, JSON.stringify(order)),
      { key: ORDER_KEY, order: ['journal', 'ghost-tab', 'aufgaben'] },
    );
    await page.reload();

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const labels = await nav.locator('.nav__label').allInnerTexts();

    expect(labels).toEqual([
      'Journal',
      'Aufgaben',
      ...NAV_ITEMS.filter((item) => item.id !== 'journal' && item.id !== 'aufgaben').map((item) => item.label),
    ]);
  });
});

test.describe('Dark Mode (issue #205 AC7)', () => {
  test('die Reihenfolge-Buttons benutzen nur Tokens, keine Rohfarben', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/einstellungen');

    const button = page.getByRole('button', { name: `${NAV_ITEMS[0].label} nach unten` });
    const color = await button.evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe('rgb(0, 0, 0)');
    expect(color).not.toBe('');
  });
});
