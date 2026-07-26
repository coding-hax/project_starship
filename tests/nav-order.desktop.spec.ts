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
