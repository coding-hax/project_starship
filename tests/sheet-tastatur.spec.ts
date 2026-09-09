import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Emulate an on-screen keyboard the only way headless Chromium allows: shadow
 * `visualViewport.height` and fire `resize`, exactly like `keyboard-inset.spec.ts`
 * does. `--keyboard-inset` is what the real device's keyboard drives, and it is
 * the whole mechanism under test here.
 */
async function shrinkViewportForKeyboard(page: Page, px = 300) {
  await page.evaluate((shrinkBy) => {
    const vv = window.visualViewport!;
    const shrunk = window.innerHeight - shrinkBy;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => shrunk });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize'));
  }, px);
  await expect.poll(() => readInset(page)).toBe(`${px}px`);
}

function readInset(page: Page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
  );
}

/** Whole pixels — `boundingBox()` carries sub-pixel noise irrelevant to the
 * hundreds of pixels this guards against (same convention as `keyboard-inset.spec.ts`). */
async function roundedBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: Math.round(box!.x),
    y: Math.round(box!.y),
    width: Math.round(box!.width),
    height: Math.round(box!.height),
  };
}

/** The open sheet's card. A closed `<dialog>` keeps `.sheet__content` in the DOM
 * but drops out of the a11y tree, so scoping to `getByRole('dialog')` matches the
 * open one only. */
function sheetContent(page: Page) {
  return page.getByRole('dialog').locator('.sheet__content');
}

async function settleSheet(page: Page) {
  await sheetContent(page).evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)),
  );
}

/**
 * #1175: on the device the create sheet was unusable — every tap on a chip pill
 * dismissed the whole sheet instead of opening its panel.
 *
 * The chain: the sheet opens with its text field focused, so the keyboard is up and
 * `--keyboard-inset` pads `.sheet__content` by the keyboard's height (sheet.css). A
 * tap on a button focuses it by default, the field blurs, `keyboard-inset.tsx`
 * zeroes the inset on `focusout`, and the bottom-anchored card's top edge drops by
 * that padding *between press and release*. The release then lands on the backdrop,
 * and a `click` whose press and release targets differ is dispatched on their common
 * ancestor — the `<dialog>` itself, which `sheet.tsx` read as a backdrop click.
 *
 * Measured before the fix on 375×812 with a 300px keyboard: the card went from
 * y=118 to y=522, the panel never opened, the dialog closed.
 *
 * Two guards, both in `sheet.tsx`: a button press inside the card no longer steals
 * focus (AK1-AK3, AK6 — same remedy as the schedule radios in #138), and a press
 * that began on the card is never a dismiss however the layout moved (AK4/AK5).
 */
test.describe('Sheet bei offener Tastatur (#1175)', () => {
  test.beforeEach(async () => {
    await resetAppData();
  });

  async function openQuickAddWithKeyboard(page: Page) {
    await registerPasskey(page, '/aufgaben');
    await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
    const title = page.getByRole('textbox', { name: 'Titel der Aufgabe' });
    await expect(title).toBeFocused();
    await settleSheet(page);
    await shrinkViewportForKeyboard(page);
    return title;
  }

  test('AK1: Tipp auf den Wann-Chip öffnet das Panel, das Sheet bleibt offen', async ({ page }) => {
    await openQuickAddWithKeyboard(page);

    await page.getByRole('button', { name: /^Fälligkeit(,|$)/ }).click();

    await expect(page.locator('.due-picker')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('AK2: der Tipp lässt Fokus und Tastatur stehen, die Karte fällt nicht zusammen', async ({
    page,
  }) => {
    const title = await openQuickAddWithKeyboard(page);
    const innerHeight = await page.evaluate(() => window.innerHeight);

    const before = await roundedBox(sheetContent(page));

    await page.getByRole('button', { name: /^Fälligkeit(,|$)/ }).click();
    await expect(page.locator('.due-picker')).toBeVisible();

    // The real regression signal: focus never left the title field, so a device's OS
    // would never have had a reason to close the keyboard and collapse the card.
    await expect(title).toBeFocused();
    expect(await readInset(page)).toBe('300px');

    // Not "the box is unchanged": the Wann panel is a full month calendar, so the
    // card legitimately grows *upward* when it opens (measured 118 → 0 on 375×812,
    // capped by sheet.css's `max-height: 100%`). The bug was the opposite direction —
    // the card shrinking by the keyboard's 300px and its top edge dropping to y=522,
    // which is what put the backdrop under the finger. So: the top edge may rise,
    // never fall, and the card stays anchored to the bottom edge either way.
    const after = await roundedBox(sheetContent(page));
    expect(after.y).toBeLessThanOrEqual(before.y);
    expect(after.y + after.height).toBe(innerHeight);
    expect(before.y + before.height).toBe(innerHeight);
  });

  test('AK3: „Heute" im Wann-Panel setzt die Fälligkeit, ohne das Sheet zu schließen', async ({
    page,
  }) => {
    const title = await openQuickAddWithKeyboard(page);
    await page.getByRole('button', { name: /^Fälligkeit(,|$)/ }).click();
    await expect(page.locator('.due-picker')).toBeVisible();

    await page.getByRole('button', { name: 'Heute', exact: true }).click();

    // The chip now carries a value — its accessible name grows from the bare field
    // name to "Fälligkeit, <Wert>".
    await expect(page.getByRole('button', { name: /^Fälligkeit, / })).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(title).toBeFocused();
    expect(await readInset(page)).toBe('300px');
  });

  test('AK4: ein auf der Karte begonnener Druck schließt nicht, auch wenn er über dem Backdrop endet', async ({
    page,
  }) => {
    await openQuickAddWithKeyboard(page);
    const card = await roundedBox(sheetContent(page));

    // Press on the card's own padding (no control under it, so the pull-to-dismiss
    // handler from #757 is the only thing watching), then release far above the
    // card — where the backdrop is. That is the geometry the collapsing keyboard
    // produced on the device, reproduced without needing the collapse itself.
    await page.mouse.move(card.x + card.width / 2, card.y + 4);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2, 10);
    await page.mouse.up();

    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('AK5: Backdrop-Klick, „Abbrechen" und ESC schließen weiterhin', async ({ page }) => {
    await openQuickAddWithKeyboard(page);
    const card = await roundedBox(sheetContent(page));

    // A real backdrop click: press and release both above the card.
    await page.mouse.click(card.x + card.width / 2, 10);
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('AK6: dasselbe im Termin-Sheet — der Wann-Chip öffnet sein Panel', async ({ page }) => {
    await registerPasskey(page, '/kalender');
    await page.getByRole('button', { name: 'Termin erfassen' }).click();

    const titleField = page.getByLabel('Titel');
    await expect(titleField).toBeFocused();
    await settleSheet(page);
    await shrinkViewportForKeyboard(page);

    await page.getByRole('button', { name: /^Wann(,|$)/ }).click();

    await expect(page.getByRole('dialog').getByLabel('Ganztägig')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(titleField).toBeFocused();
    expect(await readInset(page)).toBe('300px');
  });
});
