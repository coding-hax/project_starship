import { expect, test, type Page } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey } from './helpers';

const ORDER_KEY = 'starship:nav-order';

declare global {
  interface Window {
    __scrollIntoViewCalls: ScrollIntoViewOptions[];
  }
}

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

/** Appends a 6th, non-active clone to `.nav__list` — stands in for #180's Garmin tab,
 * which is what actually pushes the bottom nav past five entries. Pure DOM
 * manipulation in the test, no app code touched. */
async function addSixthNavItem(page: Page) {
  await page.locator('.nav__list').evaluate((list) => {
    const clone = list.children[0].cloneNode(true) as HTMLElement;
    clone.querySelector('[aria-current]')?.removeAttribute('aria-current');
    list.appendChild(clone);
  });
}

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test.describe('Karussell bei mehr Einträgen als Plätzen (issue #205 AC1)', () => {
  test('mehr als fünf Einträge schrumpfen die Plätze nicht, sondern scrollen darüber hinaus', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');

    const list = page.locator('.nav__list');
    const clientWidth = await list.evaluate((el) => el.clientWidth);
    expect(await list.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(clientWidth + 1);

    await addSixthNavItem(page);

    const itemWidth = await list.locator('.nav__item').first().evaluate((el) => el.getBoundingClientRect().width);
    // Five slots stay the visible amount regardless of how many entries exist — a
    // sixth entry scrolls past them instead of shrinking all six to fit.
    expect(itemWidth * 5).toBeCloseTo(clientWidth, 0);
    expect(await list.evaluate((el) => el.scrollWidth)).toBeGreaterThan(clientWidth + 1);
  });

  test('jeder Eintrag rastet bündig ein statt am Rand abgeschnitten zu bleiben', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');

    const list = page.locator('.nav__list');
    await addSixthNavItem(page);
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

  test('.nav__list und .nav__item tragen die Scroll-Snap-Deklarationen fürs Karussell', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');

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
  test('ein überlaufendes Karussell holt den aktiven Eintrag beim Navigieren selbst heran', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');
    await trackScrollIntoView(page);
    await registerPasskey(page);

    await addSixthNavItem(page);
    const list = page.locator('.nav__list');
    // Scroll the currently-active tab (Übersicht, first slot) out of view before
    // navigating away — simulates arriving on a screen after having swiped the
    // carousel elsewhere.
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(
      () => window.__scrollIntoViewCalls,
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  test('ein Karussell ohne Überlauf scrollt nicht von selbst (nichts zu tun, nichts passiert)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');
    await trackScrollIntoView(page);
    await registerPasskey(page);

    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Journal' }).click();
    await expect(page).toHaveURL(/\/journal$/);

    const calls = await page.evaluate(
      () => window.__scrollIntoViewCalls,
    );
    expect(calls.length).toBe(0);
  });
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

test.describe('ab 768px bleibt die Sidebar eine vertikale Liste (issue #205 AC5)', () => {
  test('die Sidebar überläuft nicht horizontal und trägt keine Snap-Deklarationen', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Nur die Sidebar-Fassung ab 768px');

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

test.describe('reduzierte Bewegung (issue #205 AC6)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('ein überlaufendes Karussell springt ohne Scroll-Animation an die aktive Position', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Karussell existiert nur auf der mobilen Leiste');
    await trackScrollIntoView(page);
    await registerPasskey(page);

    await addSixthNavItem(page);
    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Aufgaben' }).click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(
      () => window.__scrollIntoViewCalls,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.behavior).toBe('auto');
  });

  test('Touch-Ziele bleiben ≥44×44px, die Home-Indicator-Aussparung bleibt erhalten', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Prüft den mobilen Bodensteg');

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
