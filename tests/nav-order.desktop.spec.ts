import { expect, test } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

/**
 * Sidebar assertion that only holds from 768px up — see nav-order.mobile.spec.ts
 * for why this lives in its own file instead of a runtime `test.skip`.
 */

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test.describe('ab 768px bleibt die Sidebar eine vertikale Liste (issue #205 AC5)', () => {
  test('die Sidebar überläuft nicht horizontal und trägt keine Snap-Deklarationen', async ({ page }) => {
    const list = page.locator('.nav__list');
    const { overflowX, scrollSnapType, flexDirection } = await list.evaluate((el) => {
      const style = getComputedStyle(el);
      return { overflowX: style.overflowX, scrollSnapType: style.scrollSnapType, flexDirection: style.flexDirection };
    });
    expect(overflowX).toBe('visible');
    expect(scrollSnapType).toBe('none');
    expect(flexDirection).toBe('column');

    for (const item of NAV_ITEMS) {
      await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: item.label })).toBeVisible();
    }
  });
});

test.describe('Karussell-Fix wirkt sich nicht auf die Sidebar aus (issue #229 AC6)', () => {
  test('die Sidebar scrollt beim Navigieren nicht, alle Einträge bleiben sichtbar', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __scrollToCalls: unknown[] }).__scrollToCalls = [];
      const original = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (this: Element, arg?: ScrollToOptions | number, arg2?: number) {
        (window as unknown as { __scrollToCalls: unknown[] }).__scrollToCalls.push(arg);
        return original.call(this, arg as number, arg2 as number);
      };
    });
    await registerPasskey(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aktivitäten' }).click();
    await expect(page).toHaveURL(/\/aktivitaeten$/);

    const calls = await page.evaluate(() => (window as unknown as { __scrollToCalls: unknown[] }).__scrollToCalls);
    expect(calls.length).toBe(0);

    for (const item of NAV_ITEMS) {
      await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: item.label })).toBeVisible();
    }
  });
});
