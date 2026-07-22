import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Keyboard-safe layout (#106). Headless Chromium never shows a real software
 * keyboard and never shrinks `visualViewport`, so the real overlap is not
 * reproducible here — the last pixels stay a manual device check. These specs
 * instead guard the *mechanism*: the viewport hint is declared, and a synthetic
 * `visualViewport` shrink drives `--keyboard-inset` and lifts bottom-anchored UI.
 */
test.describe('Keyboard-safe Layout (#106)', () => {
  test.beforeEach(async () => {
    await resetAppData();
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

/**
 * #138: `SegmentedControl`'s options are real `<button>`s, and a browser's default
 * action for a pointer tap on a focusable element is to focus it — next to a text
 * field, that steals focus mid-typing. On a real device the OS reacts by closing
 * the keyboard, which (via `KeyboardInset` above) drops `--keyboard-inset` back to
 * 0 and slides the sheet down under the user's next tap. Headless Chromium has no
 * real keyboard to close, so the synthetic shrink from the block above stands in
 * for "keyboard is up" — the regression this guards against is the focus steal
 * itself, which is directly observable via `document.activeElement`.
 */
test.describe('SegmentedControl behält Fokus bei Zeigergeräten (#138)', () => {
  test.beforeEach(async () => {
    await resetAppData();
  });

  test('Tippen auf den Rhythmus schließt die synthetische Tastatur nicht, das Sheet bleibt stehen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/gewohnheiten');
    await page.getByRole('button', { name: 'Gewohnheit anlegen' }).click();

    const nameField = page.getByRole('textbox', { name: 'Name' });
    await expect(nameField).toBeFocused();

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

    // Scope to the open sheet: a closed <dialog> keeps its .sheet__content in the
    // DOM but is out of the a11y tree, so getByRole('dialog') matches only this one.
    const sheetContent = page.getByRole('dialog').locator('.sheet__content');
    const before = await sheetContent.boundingBox();

    await page.getByRole('radio', { name: 'Wöchentlich' }).click();

    // The real regression signal: focus never left the name field, so a real
    // device's OS would never have had a reason to close the keyboard.
    await expect(nameField).toBeFocused();
    const inset = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
    );
    expect(inset).toBe('300px');
    // Round to whole pixels: boundingBox() carries sub-pixel rendering noise
    // (e.g. 129 vs 129.019...) that's irrelevant to the regression being guarded.
    const round = (box: NonNullable<Awaited<ReturnType<typeof sheetContent.boundingBox>>>) => ({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
    const after = await sheetContent.boundingBox();
    expect(after).not.toBeNull();
    expect(round(after!)).toEqual(round(before!));
  });
});
