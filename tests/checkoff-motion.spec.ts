import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * `getComputedStyle` right after `.click()` can catch the CSS transition mid-flight
 * (the browser needs a style/layout pass before a transitioned property lands on its
 * target value) — a single read is a race, not a fact about the app. Polling for the
 * settled value is the correct wait, not a loosened assertion: the target value is
 * exactly what AC1/AC4/AC5 require, we just stop guessing when to look for it.
 */
async function scaleOf(checkbox: Locator): Promise<number> {
  return checkbox.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
}

async function waitForScale(checkbox: Locator, expected: number) {
  await expect.poll(() => scaleOf(checkbox)).toBeCloseTo(expected, 2);
}

async function waitForNoTransform(checkbox: Locator) {
  await expect
    .poll(() => checkbox.evaluate((el) => getComputedStyle(el).transform))
    .toBe('none');
}

async function waitForOpacity(item: Locator, expected: string) {
  await expect.poll(() => item.evaluate((el) => getComputedStyle(el).opacity)).toBe(expected);
}

/**
 * A row that has just been seeded plays its own enter animation (issue #430,
 * `list-enter`: `translateY(8px)` → `none`). `getBoundingClientRect` includes
 * transforms, so reading a *neighbour's* box while that animation is still in
 * flight captures an interpolated position, and the comparison after the click
 * then measures the animation finishing rather than a reflow — a ~3 px phantom
 * shift, and a flaky one, because it depends on when the read lands.
 *
 * Waiting for the row's own animations to finish is the precondition the AC3/AC5
 * assertions always assumed; the assertions themselves stay exact.
 */
async function waitForEnterSettled(item: Locator) {
  await expect
    .poll(() => item.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running')))
    .toBe(false);
}

/**
 * `Locator.boundingBox()` is viewport-relative — on a short viewport, clicking a
 * checkbox near the fold makes the browser scroll it into view, which shifts every
 * element's viewport box by the same amount and would misread scroll as reflow.
 * Document coordinates (adding the scroll offset back in) isolate the thing AC3
 * actually asks about: did the row move relative to the page, not the window.
 */
async function documentBox(locator: Locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Proves the checkbox-checkoff micro-interaction (issue #435) for tasks and
 * habits in one place, over the same battery of assertions — the point of
 * the ticket is that both behave identically, so one divergent case here
 * would be the bug.
 */
interface Case {
  kind: string;
  path: string;
  listName: string;
  itemDoneClass: string;
  seed: (page: Page, name: string) => Promise<string>;
  checkboxLabel: (name: string) => string;
  /**
   * Puts a row into a state that already contains every element it will show
   * after the click — for a habit, a pre-existing streak, so its badge is
   * already on screen. Without this, checking off a brand-new habit reveals
   * the streak badge for the first time, which is its own (pre-existing,
   * out-of-scope-for-#435) layout shift and would be conflated with the
   * checkbox motion this suite actually tests.
   */
  primeBeforeCheckoff?: (page: Page, id: string, name: string) => Promise<unknown>;
}

const CASES: Case[] = [
  {
    kind: 'Aufgabe',
    path: '/aufgaben',
    listName: 'Aufgaben',
    itemDoneClass: 'task-list__item--done',
    seed: (page, title) =>
      page.evaluate(
        (t) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: t } }),
        title,
      ),
    checkboxLabel: (title) => `${title} als erledigt markieren`,
  },
  {
    kind: 'Gewohnheit',
    path: '/uebersicht',
    listName: 'Gewohnheiten heute',
    itemDoneClass: 'habit-today__item--done',
    seed: (page, name) =>
      page.evaluate(
        (n) =>
          window.__starship.mutate({
            table: 'habits',
            op: 'upsert',
            payload: { name: n, schedule: 'daily', color: null, archivedAt: null },
          }),
        name,
      ),
    checkboxLabel: (name) => `${name} für heute abhaken`,
    primeBeforeCheckoff: async (page, habitId, name) => {
      await page.evaluate(
        (args) =>
          window.__starship.mutate({
            table: 'habit_logs',
            op: 'upsert',
            payload: { habitId: args.habitId, logDate: args.logDate, done: true },
          }),
        { habitId, logDate: yesterdayKey() },
      );
      // The mutation above lands in IndexedDB asynchronously; the streak badge
      // only appears once the live query re-renders. Waiting for it here is what
      // makes it "already on screen" for the boxBefore read that follows.
      const item = itemsFor(page, 'Gewohnheiten heute').filter({ hasText: name });
      await expect(item.locator('.habit-today__streak')).toBeVisible();
    },
  },
];

function itemsFor(page: Page, listName: string) {
  return page.getByRole('list', { name: listName }).getByRole('listitem');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await registerPasskey(page);
});

for (const c of CASES) {
  test.describe(`Abhak-Mikrointeraktion: ${c.kind}`, () => {
    test(`${c.kind}: Bewegung nur transform, ≤ 400 ms, kein Bounce/Konfetti (AC1, AC4)`, async ({
      page,
    }) => {
      await page.goto(c.path);
      const name = `${c.kind} eins`;
      await c.seed(page, name);
      const checkbox = page.getByRole('checkbox', { name: c.checkboxLabel(name) });

      const style = await checkbox.evaluate((el) => {
        const computed = getComputedStyle(el);
        return {
          property: computed.transitionProperty,
          duration: computed.transitionDuration,
          timing: computed.transitionTimingFunction,
        };
      });
      expect(style.property).toBe('transform');
      expect(parseFloat(style.duration)).toBeLessThanOrEqual(0.4);
      expect(style.timing).toBe('cubic-bezier(0.22, 1, 0.36, 1)');

      const pseudoAnimations = await checkbox.evaluate((el) => ({
        before: getComputedStyle(el, '::before').animationName,
        after: getComputedStyle(el, '::after').animationName,
      }));
      expect(pseudoAnimations.before).toBe('none');
      expect(pseudoAnimations.after).toBe('none');

      await checkbox.click();
      await waitForScale(checkbox, 1.12);

      // A pure scale matrix (b = c = e = f = 0) rules out any translation, i.e. a bounce.
      const matrix = await checkbox.evaluate((el) => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
      });
      expect(matrix.a).toBeCloseTo(1.12, 2);
      expect(matrix.d).toBeCloseTo(1.12, 2);
      expect(matrix.b).toBe(0);
      expect(matrix.c).toBe(0);
      expect(matrix.e).toBe(0);
      expect(matrix.f).toBe(0);
    });

    test(`${c.kind}: reduzierte Bewegung (Media Query) unterdrückt Transform, Erledigt bleibt sichtbar (AC2)`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(c.path);
      const name = `${c.kind} reduziert media`;
      await c.seed(page, name);
      const checkbox = page.getByRole('checkbox', { name: c.checkboxLabel(name) });
      const item = itemsFor(page, c.listName).filter({ hasText: name });

      await checkbox.click();

      await expect(checkbox).toBeChecked();
      await waitForNoTransform(checkbox);
      await expect(item).toHaveClass(new RegExp(c.itemDoneClass));
      await waitForOpacity(item, '0.6');
    });

    test(`${c.kind}: reduzierte Bewegung (In-App-Schalter) unterdrückt Transform, Erledigt bleibt sichtbar (AC2)`, async ({
      page,
    }) => {
      await page.goto(c.path);
      await page.evaluate(() => {
        document.documentElement.dataset.reduceMotion = 'true';
      });
      const name = `${c.kind} reduziert schalter`;
      await c.seed(page, name);
      const checkbox = page.getByRole('checkbox', { name: c.checkboxLabel(name) });
      const item = itemsFor(page, c.listName).filter({ hasText: name });

      await checkbox.click();

      await expect(checkbox).toBeChecked();
      await waitForNoTransform(checkbox);
      await expect(item).toHaveClass(new RegExp(c.itemDoneClass));
      await waitForOpacity(item, '0.6');
    });

    test(`${c.kind}: kein Layout-Shift beim Abhaken (AC3)`, async ({ page }) => {
      await page.goto(c.path);
      const firstName = `${c.kind} A`;
      const secondName = `${c.kind} B`;
      const firstId = await c.seed(page, firstName);
      await c.seed(page, secondName);
      await c.primeBeforeCheckoff?.(page, firstId, firstName);

      // The neighbour, not the checked item itself — its box legitimately contains
      // the transform under test, so it is not honest evidence against a shift.
      const secondItem = itemsFor(page, c.listName).filter({ hasText: secondName });
      await waitForEnterSettled(secondItem);
      const boxBefore = await documentBox(secondItem);

      const firstCheckbox = page.getByRole('checkbox', { name: c.checkboxLabel(firstName) });
      await firstCheckbox.click();

      const boxAfter = await documentBox(secondItem);
      expect(boxAfter).toEqual(boxBefore);
    });

    for (const viewport of [
      { name: '375px', width: 375, height: 667 },
      { name: '1280px', width: 1280, height: 1024 },
    ]) {
      test(`${c.kind}: Skalierung ohne Layout-Shift bei ${viewport.name}, Dark Mode (AC5)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(c.path);
        const firstName = `${c.kind} dunkel A`;
        const secondName = `${c.kind} dunkel B`;
        const firstId = await c.seed(page, firstName);
        await c.seed(page, secondName);
        await c.primeBeforeCheckoff?.(page, firstId, firstName);

        const secondItem = itemsFor(page, c.listName).filter({ hasText: secondName });
        await waitForEnterSettled(secondItem);
        const boxBefore = await documentBox(secondItem);

        const firstCheckbox = page.getByRole('checkbox', { name: c.checkboxLabel(firstName) });
        await firstCheckbox.click();
        await waitForScale(firstCheckbox, 1.12);

        const matrix = await firstCheckbox.evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          return { a: m.a, b: m.b };
        });
        expect(matrix.a).toBeCloseTo(1.12, 2);
        expect(matrix.b).toBe(0);

        const boxAfter = await documentBox(secondItem);
        expect(boxAfter).toEqual(boxBefore);
      });
    }
  });
}
