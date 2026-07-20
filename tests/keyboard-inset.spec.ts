import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

/**
 * Keyboard-safe layout (#106). Headless Chromium never shows a real software
 * keyboard and never shrinks `visualViewport`, so the real overlap is not
 * reproducible here — the last pixels stay a manual device check. These specs
 * instead guard the *mechanism*: the viewport hint is declared, and a synthetic
 * `visualViewport` shrink drives `--keyboard-inset` and lifts bottom-anchored UI.
 */
test.describe('Keyboard-safe Layout (#106)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('Viewport-Meta deklariert interactive-widget=resizes-content', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');
    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content).toContain('interactive-widget=resizes-content');
  });

  test('ohne Tastatur ist --keyboard-inset 0px', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');
    const inset = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
    );
    expect(inset).toBe('0px');
  });

  test('synthetische Tastatur setzt --keyboard-inset und hebt den FAB an', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    await expect(fab).toBeVisible();
    const before = await fab.boundingBox();
    expect(before).not.toBeNull();

    // Emulate an on-screen keyboard: shadow visualViewport.height by 300px, fire resize.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      const shrunk = window.innerHeight - 300;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => shrunk });
      Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
      vv.dispatchEvent(new Event('resize'));
    });

    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
        ),
      )
      .toBe('300px');

    const after = await fab.boundingBox();
    expect(after).not.toBeNull();
    // The FAB lifted by ~the keyboard height (a few px slack for rounding).
    expect(before!.y - after!.y).toBeGreaterThan(290);
  });
});
