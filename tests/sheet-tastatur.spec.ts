import { expect, test, type Page } from '@playwright/test';
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
});
