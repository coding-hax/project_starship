import { expect, test, type Page } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

declare global {
  interface Window {
    __scrollIntoViewCalls: ScrollIntoViewOptions[];
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
 * Records every `scrollIntoView` call an `Element` receives, before the app's own
 * scripts run. Lets AC2/AC6 assert *that* the nav scrolled its active entry (and
 * *how*, `behavior: 'auto'` vs `'smooth'`) without depending on the timing of a real
 * scroll/snap animation settling.
 */
async function trackScrollIntoView(page: Page) {
  await page.addInitScript(() => {
    window.__scrollIntoViewCalls = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      window.__scrollIntoViewCalls.push(arg as ScrollIntoViewOptions);
      return original.call(this, arg as ScrollIntoViewOptions);
    };
  });
}

/**
 * #180 added a real 6th entry (Aktivitäten), so the bottom nav overflows five slots
 * by default now. One test still needs the pre-#180 no-overflow baseline to prove
 * the "nothing to do, nothing happens" case. Removing a `.nav__item` node directly
 * does not survive it — a client-side navigation re-renders `Nav` from the same
 * (unchanged) `NAV_ITEMS`/`useNavOrder` state and the removed node comes right
 * back, overflow and all. A stylesheet override does survive: it is a plain
 * `<style>` tag outside React's tree, so it stays in the document across the SPA
 * route change this test triggers. Shrinking every slot below the real 20%
 * (shell.css) is enough to fit all six without scrolling.
 */
async function forceNoOverflow(page: Page) {
  await page.addStyleTag({ content: '.nav__item { flex-basis: 16% !important; }' });
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

test.describe('aktiver Eintrag beim Laden (issue #205 AC2)', () => {
  test('ein überlaufendes Karussell holt den aktiven Eintrag beim Navigieren selbst heran', async ({ page }) => {
    await trackScrollIntoView(page);
    await registerPasskey(page);

    const list = page.locator('.nav__list');
    // Scroll the currently-active tab (Übersicht, first slot) out of view before
    // navigating away — simulates arriving on a screen after having swiped the
    // carousel elsewhere.
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollIntoViewCalls);
    expect(calls.length).toBeGreaterThan(0);
  });

  test('ein Karussell ohne Überlauf scrollt nicht von selbst (nichts zu tun, nichts passiert)', async ({ page }) => {
    await trackScrollIntoView(page);
    await registerPasskey(page);
    // Back to the pre-#180 no-overflow baseline.
    await forceNoOverflow(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Journal' }).click();
    await expect(page).toHaveURL(/\/journal$/);

    const calls = await page.evaluate(() => window.__scrollIntoViewCalls);
    expect(calls.length).toBe(0);
  });
});

test.describe('reduzierte Bewegung (issue #205 AC6)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('ein überlaufendes Karussell springt ohne Scroll-Animation an die aktive Position', async ({ page }) => {
    await trackScrollIntoView(page);
    await registerPasskey(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollIntoViewCalls);
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

// INSTRUMENTED TEST FOR DIAGNOSIS - TEMPORARY
test('INSTRUMENTED: Karussell ohne Überlauf (diagnostik)', async ({ page }) => {
  await trackScrollIntoView(page);
  await registerPasskey(page);
  await forceNoOverflow(page);

  // Give the style time to apply
  await page.waitForTimeout(100);

  // Check 1: Is the style tag still present?
  const styleCount = await page.evaluate(() => document.styleSheets.length);
  const styleRules = await page.evaluate(() => {
    for (let i = 0; i < document.styleSheets.length; i++) {
      try {
        const sheet = document.styleSheets[i];
        for (let j = 0; j < sheet.cssRules.length; j++) {
          const rule = sheet.cssRules[j];
          if ('selectorText' in rule && rule.selectorText === '.nav__item') {
            return (rule as CSSStyleRule).cssText;
          }
        }
      } catch (e) {
        // Cross-origin stylesheets throw
      }
    }
    return 'NOT FOUND';
  });

  // Check 2: Computed flex-basis of first nav item
  const flexBasis = await page.locator('.nav__item').first().evaluate((el) => getComputedStyle(el).flexBasis);

  // Check 3: scrollWidth and clientWidth BEFORE the click
  const listDimsBefore = await page.locator('.nav__list').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft,
  }));

  console.log('BEFORE CLICK:');
  console.log('  styleSheets.length:', styleCount);
  console.log('  .nav__item rule:', styleRules);
  console.log('  computed flex-basis:', flexBasis);
  console.log('  list.scrollWidth:', listDimsBefore.scrollWidth);
  console.log('  list.clientWidth:', listDimsBefore.clientWidth);
  console.log('  list.scrollLeft:', listDimsBefore.scrollLeft);
  console.log('  overflow?', listDimsBefore.scrollWidth > listDimsBefore.clientWidth);

  // Now track navigation type
  let hadFullDocRequest = false;
  page.on('framenavigated', () => {
    hadFullDocRequest = true;
    console.log('  -> framenavigated event fired (FULL PAGE NAV)');
  });

  // Click
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/\/journal$/);

  // Small delay to allow the effect to run
  await page.waitForTimeout(200);

  // Check the state AFTER navigation
  const listDimsAfter = await page.locator('.nav__list').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));

  const calls = await page.evaluate(() => window.__scrollIntoViewCalls);

  console.log('\nAFTER NAVIGATION:');
  console.log('  list.scrollWidth:', listDimsAfter.scrollWidth);
  console.log('  list.clientWidth:', listDimsAfter.clientWidth);
  console.log('  overflow?', listDimsAfter.scrollWidth > listDimsAfter.clientWidth);
  console.log('  framenavigated fired?', hadFullDocRequest);
  console.log('  scrollIntoView calls:', calls.length);

  expect(calls.length).toBe(0);
});
