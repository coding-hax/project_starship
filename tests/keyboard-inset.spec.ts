import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

async function shrinkViewportForKeyboard(page: Page, px = 300) {
  await page.evaluate((shrinkBy) => {
    const vv = window.visualViewport!;
    const shrunk = window.innerHeight - shrinkBy;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => shrunk });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, px);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
      ),
    )
    .toBe(`${px}px`);
}

/**
 * `boundingBox().y >= 0` and its bottom edge above where the keyboard starts.
 * Rounded to whole pixels — sub-pixel layout noise (e.g. -0.19) is irrelevant
 * to the regression this guards against, same convention as the #138 test above.
 */
async function expectVisibleAboveKeyboard(page: Page, locator: Locator, keyboardPx: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.y)).toBeGreaterThanOrEqual(0);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(innerHeight - keyboardPx);
}

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
 * #138: the schedule fieldset's options are focusable controls, and a browser's
 * default action for a pointer tap on a focusable element is to focus it — next
 * to a text field, that steals focus mid-typing. On a real device the OS reacts
 * by closing the keyboard, which (via `KeyboardInset` above) drops
 * `--keyboard-inset` back to 0 and slides the sheet down under the user's next
 * tap. Headless Chromium has no real keyboard to close, so the synthetic shrink
 * from the block above stands in for "keyboard is up" — the regression this
 * guards against is the focus steal itself, which is directly observable via
 * `document.activeElement`.
 *
 * Probes "Monatlich", not "Wöchentlich" (issue #509): selecting "Wöchentlich"
 * now legitimately grows the sheet — it reveals the 1–6× target picker — so it
 * would conflate that intentional layout change with the regression this test
 * guards against. "Monatlich" exercises the same radio-click/focus code path
 * without adding any UI, keeping the bounding-box assertion meaningful.
 */
test.describe('Rhythmus-Auswahl behält Fokus bei Zeigergeräten (#138)', () => {
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

    // Scope to the open sheet: a closed <dialog> keeps its .sheet__content in the
    // DOM but is out of the a11y tree, so getByRole('dialog') matches only this one.
    const sheetContent = page.getByRole('dialog').locator('.sheet__content');
    // The sheet slides up over `--duration-base` (sheet.css's opening transition) --
    // reading a position before it settles races that transition instead of testing
    // the actual regression, and the race is exactly what's flaky about CI machine
    // speed. `getAnimations()` covers CSS transitions too, not just `@keyframes`.
    await sheetContent.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

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

    const before = await sheetContent.boundingBox();

    await page.getByRole('radio', { name: 'Monatlich' }).click();

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

/**
 * #594: `.sheet__content` grows upward by `--keyboard-inset` (sheet.css) but
 * had no `max-height`/`overflow-y` — a card taller than the visible viewport
 * pushed its top, and with it the focused field, off the top of the screen
 * with nothing to scroll it back into view.
 */
test.describe('Sheet-Inhalt bleibt bei offener Tastatur sichtbar (#594)', () => {
  test.beforeEach(async () => {
    await resetAppData();
  });

  test('Gewohnheits-Sheet: Namensfeld und Karte bleiben bei offener Tastatur sichtbar', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/gewohnheiten');
    await page.getByRole('button', { name: 'Gewohnheit anlegen' }).click();

    const nameField = page.getByRole('textbox', { name: 'Name' });
    await expect(nameField).toBeFocused();
    const sheetContent = page.getByRole('dialog').locator('.sheet__content');

    await shrinkViewportForKeyboard(page);

    await expectVisibleAboveKeyboard(page, nameField, 300);
    const contentBox = await sheetContent.boundingBox();
    expect(contentBox).not.toBeNull();
    expect(Math.round(contentBox!.y)).toBeGreaterThanOrEqual(0);
  });

  test('Termin-Sheet: Titelfeld und Karte bleiben bei offener Tastatur sichtbar', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/kalender');
    await page.getByRole('button', { name: 'Termin erfassen' }).click();

    const titleField = page.getByLabel('Titel');
    await expect(titleField).toBeFocused();
    const sheetContent = page.getByRole('dialog').locator('.sheet__content');

    await shrinkViewportForKeyboard(page);

    await expectVisibleAboveKeyboard(page, titleField, 300);
    const contentBox = await sheetContent.boundingBox();
    expect(contentBox).not.toBeNull();
    expect(Math.round(contentBox!.y)).toBeGreaterThanOrEqual(0);
  });

  test('hoher Sheet-Inhalt wird bei offener Tastatur im Sheet scrollbar', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/gewohnheiten');
    await page.getByRole('button', { name: 'Gewohnheit anlegen' }).click();
    // "Wöchentlich" reveals the 1–6× target picker (issue #509) — tall enough
    // together with the six schedule radios and four colour options to exceed
    // the ~512px left once a 300px keyboard covers the bottom of a 812px screen.
    await page.getByRole('radio', { name: 'Wöchentlich' }).click();

    await shrinkViewportForKeyboard(page);

    const sheetContent = page.getByRole('dialog').locator('.sheet__content');
    const { scrollHeight, clientHeight } = await sheetContent.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    const submitButton = sheetContent.getByRole('button', { name: 'Anlegen', exact: true });
    await submitButton.scrollIntoViewIfNeeded();
    await expect(submitButton).toBeInViewport();

    // Scrolling back to the top brings the name field back into view — the
    // top of the content is not stranded once you have scrolled down.
    await sheetContent.evaluate((el) => el.scrollTo({ top: 0 }));
    const nameField = page.getByRole('textbox', { name: 'Name' });
    await expectVisibleAboveKeyboard(page, nameField, 300);
  });

  test('ohne Tastatur sitzt das Gewohnheits-Sheet weiterhin bündig am unteren Rand', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/gewohnheiten');
    await page.getByRole('button', { name: 'Gewohnheit anlegen' }).click();

    const sheetContent = page.getByRole('dialog').locator('.sheet__content');
    await sheetContent.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = await sheetContent.boundingBox();
    expect(box).not.toBeNull();
    const innerHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.round(box!.y + box!.height)).toBe(innerHeight);
  });

  test('ohne Tastatur sitzt das Termin-Sheet weiterhin bündig am unteren Rand', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/kalender');
    await page.getByRole('button', { name: 'Termin erfassen' }).click();

    const sheetContent = page.getByRole('dialog').locator('.sheet__content');
    await sheetContent.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = await sheetContent.boundingBox();
    expect(box).not.toBeNull();
    const innerHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.round(box!.y + box!.height)).toBe(innerHeight);
  });

  test('prefers-reduced-motion: Sichtbarkeitsgrenzen gelten bei offener Tastatur unverändert', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await registerPasskey(page);
    await page.goto('/gewohnheiten');
    await page.getByRole('button', { name: 'Gewohnheit anlegen' }).click();

    const nameField = page.getByRole('textbox', { name: 'Name' });
    await expect(nameField).toBeFocused();

    await shrinkViewportForKeyboard(page);

    await expectVisibleAboveKeyboard(page, nameField, 300);
  });
});
