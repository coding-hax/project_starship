import { expect, test, type Page } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

declare global {
  interface Window {
    __scrollToCalls: ScrollToOptions[];
  }
}

/**
 * Carousel assertions that only hold in the mobile bottom nav — the carousel does
 * not exist in the desktop sidebar (issue #205 AC5). Playwright routes this file to
 * the `mobile` project alone (playwright.config.ts), the framework's own mechanism
 * for viewport-scoped specs; see shell.mobile.spec.ts for why this beats a runtime
 * per-project skip call (`test-integrity` rejects those on sight).
 */

/**
 * Records every `scrollTo` call an `Element` receives, before the app's own scripts
 * run. Lets AC2/AC5 assert *that* the nav scrolled its active entry (and *how*,
 * `behavior: 'auto'` vs `'smooth'`) without depending on the timing of a real
 * scroll/snap animation settling.
 *
 * Not `scrollIntoView` (pre-#229): the fix moved off it precisely because it walks
 * every scrollable ancestor instead of targeting `.nav__list` alone (issue #229) —
 * spying on it here would silently stop observing anything the moment the fix landed.
 */
async function trackScrollTo(page: Page) {
  await page.addInitScript(() => {
    window.__scrollToCalls = [];
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (this: Element, arg?: ScrollToOptions | number, arg2?: number) {
      if (typeof arg === 'object' && arg !== null) window.__scrollToCalls.push(arg);
      return original.call(this, arg as number, arg2 as number);
    };
  });
}

/**
 * #180 added a real 6th entry (Aktivitäten), so the bottom nav overflows five slots
 * by default now. One test still needs the pre-#180 no-overflow baseline to prove
 * the "nothing to do, nothing happens" case. Removing a `.nav__item` node directly
 * does not survive it — a client-side navigation re-renders `Nav` from the same
 * (unchanged) `NAV_ITEMS`/`useNavOrder` state and the removed node comes right
 * back, overflow and all.
 *
 * Must be an init script, not `page.addStyleTag` -- the caller still needs a fresh
 * full navigation afterwards (to arm `trackScrollIntoView`'s prototype patch for
 * *this* document), and a style tag added to the current document does not survive
 * that reload. An init script does: it runs before Nav's mount on the very next
 * navigation, so the list never overflows in the first place, and Nav's own
 * mount-time `scrollIntoView` (issue #205 AC2) never fires. Shrinking every slot
 * below the real 20% (shell.css) is enough to fit all six without scrolling.
 *
 * The `requestAnimationFrame` retry matters: an init script runs the instant the new
 * document is created, before it has parsed so much as an `<html>` tag -- neither
 * `document.head` nor `document.documentElement` exists yet, so appending
 * immediately silently no-ops (and the override never lands at all, for the entire
 * document's lifetime).
 */
async function forceNoOverflow(page: Page) {
  await page.addInitScript(() => {
    const install = () => {
      if (!document.head) {
        requestAnimationFrame(install);
        return;
      }
      const style = document.createElement('style');
      style.textContent = '.nav__item { flex-basis: 16% !important; }';
      document.head.appendChild(style);
    };
    install();
  });
}

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test.describe('Karussell bei mehr Einträgen als Plätzen (issue #205 AC1)', () => {
  test('mehr als fünf Einträge schrumpfen die Plätze nicht, sondern scrollen darüber hinaus', async ({
    page,
  }) => {
    const list = page.locator('.nav__list');
    const clientWidth = await list.evaluate((el) => el.clientWidth);
    const itemWidth = await list.locator('.nav__item').first().evaluate((el) => el.getBoundingClientRect().width);
    // Five slots stay the visible amount regardless of how many entries exist — a
    // sixth entry scrolls past them instead of shrinking all six to fit.
    expect(itemWidth * 5).toBeCloseTo(clientWidth, 0);
    expect(await list.evaluate((el) => el.scrollWidth)).toBeGreaterThan(clientWidth + 1);
  });

  test('jeder Eintrag rastet bündig ein statt am Rand abgeschnitten zu bleiben', async ({ page }) => {
    const list = page.locator('.nav__list');
    const itemWidth = await list.locator('.nav__item').first().evaluate((el) => el.getBoundingClientRect().width);

    // Scroll to a deliberately "half a tab" position...
    await list.evaluate((el, left) => el.scrollTo({ left, behavior: 'auto' }), itemWidth * 1.5);
    // ...and let the browser's own scroll-snap machinery correct it: mandatory snap
    // plus `scroll-snap-align: start` never leaves the list resting mid-item.
    await expect
      .poll(async () => {
        const left = await list.evaluate((el) => el.scrollLeft);
        return Math.round(left / itemWidth) * itemWidth - left;
      })
      .toBeCloseTo(0, 0);
  });

  test('.nav__list und .nav__item tragen die Scroll-Snap-Deklarationen fürs Karussell', async ({ page }) => {
    const list = page.locator('.nav__list');
    const { overflowX, scrollSnapType } = await list.evaluate((el) => {
      const style = getComputedStyle(el);
      return { overflowX: style.overflowX, scrollSnapType: style.scrollSnapType };
    });
    expect(overflowX).toBe('auto');
    expect(scrollSnapType).toContain('mandatory');

    const scrollSnapAlign = await list
      .locator('.nav__item')
      .first()
      .evaluate((el) => getComputedStyle(el).scrollSnapAlign);
    expect(scrollSnapAlign).toBe('start');
  });
});

test.describe('Karussell rastet an den Rändern bündig ein (issue #229)', () => {
  test('AC1: den letzten Eintrag antippen füllt fünf Plätze, kein leerer Rand rechts', async ({ page }) => {
    await registerPasskey(page);
    const list = page.locator('.nav__list');

    // Swipe the carousel to its end so the last entry is the one being tapped —
    // the exact repro from the bug report.
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));
    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aktivitäten' })
      .click();
    await expect(page).toHaveURL(/\/aktivitaeten$/);

    const maxScrollLeft = await list.evaluate((el) => el.scrollWidth - el.clientWidth);
    await expect
      .poll(async () => list.evaluate((el) => el.scrollLeft))
      .toBeCloseTo(maxScrollLeft, 0);

    const listBox = (await list.boundingBox())!;
    const activeBox = (await page.locator('.nav__item [aria-current="page"]').boundingBox())!;
    expect(activeBox.x + activeBox.width).toBeCloseTo(listBox.x + listBox.width, 0);
  });

  test('AC2: den ersten Eintrag von der Endposition aus antippen landet exakt bei scrollLeft 0', async ({
    page,
  }) => {
    await registerPasskey(page);
    const list = page.locator('.nav__list');

    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));
    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Übersicht' })
      .click();
    await expect(page).toHaveURL(/\/uebersicht$/);

    await expect.poll(async () => list.evaluate((el) => el.scrollLeft)).toBeCloseTo(0, 0);

    const listBox = (await list.boundingBox())!;
    const activeBox = (await page.locator('.nav__item [aria-current="page"]').boundingBox())!;
    expect(activeBox.x).toBeCloseTo(listBox.x, 0);
  });

  test('AC3: der horizontale Dokument-Scroll bleibt unverändert, die Leiste verschiebt sich nicht', async ({
    page,
  }) => {
    await registerPasskey(page);
    const list = page.locator('.nav__list');

    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));
    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aktivitäten' })
      .click();
    await expect(page).toHaveURL(/\/aktivitaeten$/);

    await expect
      .poll(async () => page.evaluate(() => document.scrollingElement?.scrollLeft ?? 0))
      .toBe(0);
  });
});

test.describe('aktiver Eintrag beim Laden (issue #205 AC2, Regression issue #229 AC4)', () => {
  test('ein überlaufendes Karussell holt den aktiven Eintrag beim Navigieren selbst heran', async ({ page }) => {
    await trackScrollTo(page);
    await registerPasskey(page);

    const list = page.locator('.nav__list');
    // Scroll the currently-active tab (Übersicht, first slot) out of view before
    // navigating away — simulates arriving on a screen after having swiped the
    // carousel elsewhere.
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBeGreaterThan(0);

    const active = page.locator('.nav__item [aria-current="page"]');
    const listBox = (await list.boundingBox())!;
    const activeBox = (await active.boundingBox())!;
    expect(activeBox.x).toBeGreaterThanOrEqual(listBox.x - 1);
    expect(activeBox.x + activeBox.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
  });

  test('ein Karussell ohne Überlauf scrollt nicht von selbst (nichts zu tun, nichts passiert)', async ({ page }) => {
    await trackScrollTo(page);
    // Back to the pre-#180 no-overflow baseline -- before the navigation below, so
    // Nav never sees an overflowing list, not even for the one mount-time
    // scroll call the overflowing case is supposed to make (see forceNoOverflow's
    // doc comment).
    await forceNoOverflow(page);
    await registerPasskey(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Journal' }).click();
    await expect(page).toHaveURL(/\/journal$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBe(0);
  });
});

test.describe('reduzierte Bewegung (issue #205 AC6, Regression issue #229 AC5)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('ein überlaufendes Karussell springt ohne Scroll-Animation an die aktive Position', async ({ page }) => {
    await trackScrollTo(page);
    await registerPasskey(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.behavior).toBe('auto');
  });

  test('Touch-Ziele bleiben ≥44×44px, die Home-Indicator-Aussparung bleibt erhalten', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    for (const item of NAV_ITEMS) {
      const box = await nav.getByRole('link', { name: item.label }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const paddingBottom = await nav.evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(paddingBottom).not.toBe('0px');
  });
});
