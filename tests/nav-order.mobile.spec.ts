import { expect, test, type Page } from '@playwright/test';
import { NAV_ITEMS } from '../src/ui/nav-items';
import { registerPasskey, resetAppData, selectView } from './helpers';

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
    Element.prototype.scrollTo = function (
      this: Element,
      arg?: ScrollToOptions | number,
      arg2?: number,
    ) {
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
    const itemWidth = await list
      .locator('.nav__item')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    // Five slots stay the visible amount regardless of how many entries exist — a
    // sixth entry scrolls past them instead of shrinking all six to fit.
    expect(itemWidth * 5).toBeCloseTo(clientWidth, 0);
    expect(await list.evaluate((el) => el.scrollWidth)).toBeGreaterThan(clientWidth + 1);
  });

  test('jeder Eintrag rastet bündig ein statt am Rand abgeschnitten zu bleiben', async ({
    page,
  }) => {
    const list = page.locator('.nav__list');
    const itemWidth = await list
      .locator('.nav__item')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);

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
  }) => {
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
  test('AC1: den letzten Eintrag antippen füllt fünf Plätze, kein leerer Rand rechts', async ({
    page,
  }) => {
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
  test('ein überlaufendes Karussell holt den aktiven Eintrag beim Navigieren selbst heran', async ({
    page,
  }) => {
    await trackScrollTo(page);
    await registerPasskey(page);

    const list = page.locator('.nav__list');
    // Scroll the currently-active tab (Übersicht, first slot) out of view before
    // navigating away — simulates arriving on a screen after having swiped the
    // carousel elsewhere.
    await list.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'auto' }));

    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aufgaben' })
      .click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBeGreaterThan(0);

    const active = page.locator('.nav__item [aria-current="page"]');
    const listBox = (await list.boundingBox())!;
    const activeBox = (await active.boundingBox())!;
    expect(activeBox.x).toBeGreaterThanOrEqual(listBox.x - 1);
    expect(activeBox.x + activeBox.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
  });

  test('ein Karussell ohne Überlauf scrollt nicht von selbst (nichts zu tun, nichts passiert)', async ({
    page,
  }) => {
    await trackScrollTo(page);
    // Back to the pre-#180 no-overflow baseline -- before the navigation below, so
    // Nav never sees an overflowing list, not even for the one mount-time
    // scroll call the overflowing case is supposed to make (see forceNoOverflow's
    // doc comment).
    await forceNoOverflow(page);
    await registerPasskey(page);

    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Journal' })
      .click();
    await expect(page).toHaveURL(/\/journal$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBe(0);
  });
});

test.describe('reduzierte Bewegung (issue #205 AC6, Regression issue #229 AC5)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('ein überlaufendes Karussell springt ohne Scroll-Animation an die aktive Position', async ({
    page,
  }) => {
    await trackScrollTo(page);
    await registerPasskey(page);

    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aufgaben' })
      .click();
    await expect(page).toHaveURL(/\/aufgaben$/);

    const calls = await page.evaluate(() => window.__scrollToCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.behavior).toBe('auto');
  });

  test('Touch-Ziele bleiben ≥44×44px, die Home-Indicator-Aussparung bleibt erhalten', async ({
    page,
  }) => {
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

test.describe('die Bottom-Nav ist auf keiner Seite transparent (issue #444)', () => {
  /**
   * `getComputedStyle().backgroundColor` serializes an oklch-sourced color
   * inconsistently across Chromium versions (sometimes `oklch(...)`, sometimes
   * `oklab(... / a)`). Painting it into a canvas and reading the pixel back is
   * source-agnostic and catches a `color-mix(..., transparent)` regression
   * (alpha < 255) regardless of how the color string itself is serialized.
   *
   * Measured on `.nav__bar`, not the outer `<nav>` (issue #889): `.nav` itself
   * is now intentionally transparent so the ambient background circles show
   * through everywhere except the pill — only `.nav__bar` carries the opaque
   * `--surface` fill the carousel's labels sit on, which is what #444's
   * "no frosted glass over nav content" regression actually guards. The same
   * distinction is already made in grundfarbe-vollfarbe.spec.ts AK2/AK4.
   */
  async function backgroundAlpha(page: Page) {
    const navBar = page.getByRole('navigation', { name: 'Hauptnavigation' }).locator('.nav__bar');
    return navBar.evaluate((el) => {
      const color = getComputedStyle(el).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    });
  }

  for (const path of ['/routinen', '/aufgaben', '/uebersicht']) {
    test(`${path}: die Nav-Pille ist voll deckend, kein Blur`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto(path);

      expect(await backgroundAlpha(page)).toBe(255);
      const backdropFilter = await page
        .getByRole('navigation', { name: 'Hauptnavigation' })
        .locator('.nav__bar')
        .evaluate((el) => getComputedStyle(el).backdropFilter);
      expect(backdropFilter).toBe('none');
    });
  }

  test('bleibt im Dark Mode voll deckend', async ({ page }) => {
    await registerPasskey(page, '/routinen');
    await page.emulateMedia({ colorScheme: 'dark' });

    expect(await backgroundAlpha(page)).toBe(255);
  });
});

/**
 * `.nav` gains a `z-index` (shell.css) because it is a DOM sibling *before* `main`
 * (focus order, layout.tsx) while its sticky screen position is visually below it —
 * without a stacking order the DOM's paint order wins once the page repaints after a
 * scroll, and page content (or the perpetually-animating `.page-transition--enter`
 * wrapper, issue #508) paints over the bar instead of under it.
 */
test.describe('die Nav bekommt eine eigene Stacking-Ebene, Seiteninhalt malt nicht mehr darüber (issue #508)', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppData();
    // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
    await page.route('**/api/sync/**', (route) => route.abort('failed'));
    await registerPasskey(page);
  });

  /**
   * Eight month grids comfortably push `/routinen` past the 812px mobile
   * viewport — the repro needs a list that scrolls under the nav, not a specific count.
   */
  async function seedOverflowingHabitList(page: Page) {
    for (let i = 1; i <= 8; i += 1) {
      await page.evaluate(
        (name) =>
          window.__starship.mutate({
            table: 'habits',
            op: 'upsert',
            payload: { name, schedule: 'daily', color: null, archivedAt: null },
          }),
        `Routine ${i}`,
      );
    }
  }

  /**
   * A plain `page.goto('/routinen')` is `page-transition.tsx`'s first render,
   * which the component deliberately skips (no incoming class on initial mount) —
   * only a client-side navigation *arriving* at the route sets `page-transition--enter`,
   * so the repro has to go through the tab bar rather than a direct navigation.
   */
  async function navigateToRoutinenWithEnterClass(page: Page) {
    await page.goto('/uebersicht');
    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Routinen' })
      .click();
    await expect(page).toHaveURL(/\/routinen$/);
    await expect(page.locator('.page-transition')).toHaveClass(/page-transition--enter/);
  }

  test('AC1: elementFromPoint auf jedem sichtbaren Tab trifft die Nav, nie eine Tageskachel', async ({
    page,
  }) => {
    await seedOverflowingHabitList(page);
    await navigateToRoutinenWithEnterClass(page);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    // The bar is a carousel past five entries (issue #205) — with six NAV_ITEMS
    // registered, the sixth stays scrolled out of the list's own viewport by
    // default and has no on-screen point to hit-test, so "jeder sichtbare Tab"
    // means every entry whose box actually falls inside the list's visible width.
    const listBox = (await page.locator('.nav__list').boundingBox())!;
    for (const item of NAV_ITEMS) {
      const link = page
        .getByRole('navigation', { name: 'Hauptnavigation' })
        .getByRole('link', { name: item.label });
      const box = (await link.boundingBox())!;
      const centerX = box.x + box.width / 2;
      if (centerX < listBox.x || centerX > listBox.x + listBox.width) continue;

      const hitsNav = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('.nav') != null,
        [centerX, box.y + box.height / 2] as const,
      );
      expect(hitsNav, `Tab „${item.label}" trifft nicht die Nav`).toBe(true);
    }
  });

  test('AC2: ein Tap auf einen sichtbaren Tab wechselt die Route statt in einer Tageskachel zu landen', async ({
    page,
  }) => {
    await seedOverflowingHabitList(page);
    await navigateToRoutinenWithEnterClass(page);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    await page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aufgaben' })
      .click();
    await expect(page).toHaveURL(/\/aufgaben$/);
  });

  test('AC3: FAB und Toast bleiben über der Nav (--z-fab / --z-toast, tokens.css)', async ({
    page,
  }) => {
    await page.goto('/aufgaben');
    await selectView(page, 'Alle');

    // FAB check first, before any toast — toast.css documents that the toast is
    // allowed to cover the FAB while it's showing ("acceptable, because it is gone
    // again in a few seconds"), so that overlap is not what AC3 is about. AC3 is
    // that neither ever sinks *below the nav*.
    const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
    await expect(fab).toBeVisible();
    const fabBox = (await fab.boundingBox())!;
    const fabHit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('.fab') != null,
      [fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2] as const,
    );
    expect(fabHit, 'FAB liegt unter der Nav statt darüber').toBe(true);

    // Seit #797 der einzige verbleibende Toast im Produkt (der entfernte
    // Lösch-Undo-Toast trug denselben `.toast`/`.toast-host`-Stacking-Kontext) —
    // mirrors toast.spec.ts's triggerSyncErrorToast: fünf fehlgeschlagene Pushes
    // in Folge über SYNC_ERROR_THRESHOLD (sync-status.tsx). Ein echter HTTP-Fehler
    // ist Pflicht: das `**/api/sync/**` -> abort im `beforeEach` dieses
    // Describe-Blocks sieht für sync.ts wie "offline" aus (fetch wirft), das zählt
    // laut outbox.ts (#182) nie auf SYNC_ERROR_THRESHOLD — nur ein `!response.ok`
    // erhöht `attempts`. Die spezifischere Route hier gewinnt vor dem Abort-all.
    await page.route('**/api/sync/push', (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.evaluate(() =>
      window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Bleibt hängen' },
      }),
    );
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__starship.sync());
    }

    const toast = page.locator('.toast--error');
    await expect(toast).toBeVisible();
    const toastBox = (await toast.boundingBox())!;
    const toastHit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('.toast') != null,
      [toastBox.x + toastBox.width / 2, toastBox.y + toastBox.height / 2] as const,
    );
    expect(toastHit, 'Toast liegt unter der Nav statt darüber').toBe(true);

    // The individual `<li role="alert">` toast carries no z-index of its own —
    // it inherits its stacking from the `.toast-host` `<ol>` it's portaled into
    // (toast.tsx/toast-host.tsx), which is where toast.css's `--z-toast` lives.
    const [navZ, fabZ, toastZ] = await Promise.all([
      page.locator('.nav').evaluate((el) => Number(getComputedStyle(el).zIndex)),
      fab.evaluate((el) => Number(getComputedStyle(el).zIndex)),
      page.locator('.toast-host').evaluate((el) => Number(getComputedStyle(el).zIndex)),
    ]);
    // Absolute values (and the full scale's ordering) are covered by the
    // z-layers tests in design-system.spec.ts — this just re-confirms the
    // relative order the AC actually cares about, nav < fab < toast.
    expect(fabZ).toBeGreaterThan(navZ);
    expect(toastZ).toBeGreaterThan(fabZ);
  });
});
