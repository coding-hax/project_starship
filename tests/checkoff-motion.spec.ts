import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

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
      const transform = await checkbox.evaluate((el) => getComputedStyle(el).transform);
      expect(transform).toBe('none');
      await expect(item).toHaveClass(new RegExp(c.itemDoneClass));
      const opacity = await item.evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe('0.6');
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
      const transform = await checkbox.evaluate((el) => getComputedStyle(el).transform);
      expect(transform).toBe('none');
      await expect(item).toHaveClass(new RegExp(c.itemDoneClass));
      const opacity = await item.evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe('0.6');
    });

    test(`${c.kind}: kein Layout-Shift beim Abhaken (AC3)`, async ({ page }) => {
      await page.goto(c.path);
      const firstName = `${c.kind} A`;
      const secondName = `${c.kind} B`;
      await c.seed(page, firstName);
      await c.seed(page, secondName);

      // The neighbour, not the checked item itself — its box legitimately contains
      // the transform under test, so it is not honest evidence against a shift.
      const secondItem = itemsFor(page, c.listName).filter({ hasText: secondName });
      const boxBefore = await secondItem.boundingBox();

      const firstCheckbox = page.getByRole('checkbox', { name: c.checkboxLabel(firstName) });
      await firstCheckbox.click();

      const boxAfter = await secondItem.boundingBox();
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
        await c.seed(page, firstName);
        await c.seed(page, secondName);

        const secondItem = itemsFor(page, c.listName).filter({ hasText: secondName });
        const boxBefore = await secondItem.boundingBox();

        const firstCheckbox = page.getByRole('checkbox', { name: c.checkboxLabel(firstName) });
        await firstCheckbox.click();

        const matrix = await firstCheckbox.evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          return { a: m.a, b: m.b };
        });
        expect(matrix.a).toBeCloseTo(1.12, 2);
        expect(matrix.b).toBe(0);

        const boxAfter = await secondItem.boundingBox();
        expect(boxAfter).toEqual(boxBefore);
      });
    }
  });
}
