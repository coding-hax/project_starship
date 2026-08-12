import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

/**
 * Design-system rules that hold app-wide. The header↔content rhythm (#85) is the
 * first: the gap under a heading comes from the spacing scale, never ad hoc.
 */
test.describe('Design-System: Heading↔Content-Abstand', () => {
  test('der Seitentitel h1 hält den Token-Abstand (--space-6 = 24px) zum Inhalt', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const h1 = page.getByRole('heading', { level: 1, name: 'Aufgaben' });
    await expect(h1).toBeVisible();

    const marginBottom = await h1.evaluate((el) => getComputedStyle(el).marginBottom);
    expect(marginBottom).toBe('24px');
  });
});

test.describe('Design-System: FAB-Glyphengröße', () => {
  test('FAB-Icon folgt --text-title (AC1)', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fabIcon = page.locator('.fab__icon');
    const fontSize = await fabIcon.evaluate((el) => getComputedStyle(el).fontSize);
    const textTitle = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text-title').trim(),
    );
    expect(fontSize).toBe(textTitle);
  });

  test('FAB-Button ist exakt 56×56px (AC2)', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const bbox = await fab.boundingBox();
    expect(bbox?.width).toBe(56);
    expect(bbox?.height).toBe(56);
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons (AC4) — 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons (AC4) — 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1024 });
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });

  test('FAB-Icon liegt innerhalb des FAB-Buttons auch auf /routinen (geteilt)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await registerPasskey(page);
    await page.goto('/routinen');

    const fab = page.locator('.fab');
    const fabIcon = page.locator('.fab__icon');

    const fabBbox = await fab.boundingBox();
    const iconBbox = await fabIcon.boundingBox();

    expect(fabBbox).not.toBeNull();
    expect(iconBbox).not.toBeNull();

    if (fabBbox && iconBbox) {
      expect(iconBbox.x).toBeGreaterThanOrEqual(fabBbox.x);
      expect(iconBbox.y).toBeGreaterThanOrEqual(fabBbox.y);
      expect(iconBbox.x + iconBbox.width).toBeLessThanOrEqual(fabBbox.x + fabBbox.width);
      expect(iconBbox.y + iconBbox.height).toBeLessThanOrEqual(fabBbox.y + fabBbox.height);
    }
  });
});

/**
 * Issue #651: h1/h2/h3 vorher ohne eigene font-size (Tailwind-Preflight setzt
 * `inherit`, die globale Regel setzte nur line-height/weight/letter-spacing) —
 * jede Überschrift rendert in 16px Fließtextgröße. Jetzt tragen h1/h2 die
 * Token-Größen, h3 bleibt bei --text-body (Betonung trägt dort das Gewicht).
 */
test.describe('Design-System: Typo-Skala Überschriften (issue #651)', () => {
  test('AC1: h1 rendert in --text-title auf /uebersicht und /einstellungen', async ({ page }) => {
    await registerPasskey(page);

    for (const path of ['/uebersicht', '/einstellungen']) {
      await page.goto(path);
      const h1 = page.getByRole('heading', { level: 1 });
      const [fontSize, textTitle] = await Promise.all([
        h1.evaluate((el) => getComputedStyle(el).fontSize),
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--text-title').trim(),
        ),
      ]);
      expect(fontSize).toBe(textTitle);
    }
  });

  test('AC1: h2 rendert in --text-section auf /uebersicht', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/uebersicht');

    const h2 = page.getByRole('heading', { name: 'Aufgaben', level: 2 });
    const [fontSize, textSection] = await Promise.all([
      h2.evaluate((el) => getComputedStyle(el).fontSize),
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--text-section').trim(),
      ),
    ]);
    expect(fontSize).toBe(textSection);
  });

  test('AC3: .section-card__title rendert in --text-section auf /einstellungen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const title = page.locator('.section-card__title').first();
    const [fontSize, textSection] = await Promise.all([
      title.evaluate((el) => getComputedStyle(el).fontSize),
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--text-section').trim(),
      ),
    ]);
    expect(fontSize).toBe(textSection);
  });

  test('AC5: das Einstellungs-Icon rendert mit 26×26px statt 24×24px', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/uebersicht');

    // Auf /uebersicht rendern ZWEI Header: der Chrome-Header aus dem Layout
    // (auf Mobile display:none) und der Inline-Header der Seite (sichtbar).
    // Beide tragen `.app-header__icon svg` — auf den sichtbaren Inline-Header
    // eingrenzen, sonst greift Playwrights Strict-Mode bei zwei Treffern.
    const icon = page.locator('.app-header--inline .app-header__icon svg');
    const bbox = await icon.boundingBox();
    expect(bbox?.width).toBe(26);
    expect(bbox?.height).toBe(26);
  });
});

/**
 * Issue #510: one named z-index scale (tokens.css) instead of scattered raw numbers,
 * so "sits above / below" is a design-system decision rather than an accident of DOM
 * order. The sheet is a modal `<dialog>` (`showModal()`), which the browser paints in
 * the top layer above everything else regardless of z-index — `--z-sheet` documents
 * that place in the scale, it does not itself create the guarantee (docs/DESIGN_SYSTEM.md
 * "Ebenen").
 */
test.describe('Design-System: Ebenen (z-Skala)', () => {
  const viewports = [
    { width: 375, height: 667 },
    { width: 1280, height: 1024 },
  ] as const;
  const themes = ['hell', 'dunkel'] as const;

  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`AC1/AC2/AC6: Skala ist gesetzt, steigend, jede Fläche trägt ihren Token (${viewport.width}px, ${theme})`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await registerPasskey(page);
        await page.goto('/aufgaben');
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

        const tokens = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return {
            nav: Number(style.getPropertyValue('--z-nav')),
            fab: Number(style.getPropertyValue('--z-fab')),
            toast: Number(style.getPropertyValue('--z-toast')),
            drag: Number(style.getPropertyValue('--z-drag')),
            sheet: Number(style.getPropertyValue('--z-sheet')),
          };
        });

        // Strictly ascending — the whole point of a scale over scattered numbers,
        // and z-values are theme-independent (same scale in light and dark).
        expect(tokens.nav).toBeGreaterThan(0);
        expect(tokens.fab).toBeGreaterThan(tokens.nav);
        expect(tokens.toast).toBeGreaterThan(tokens.fab);
        expect(tokens.drag).toBeGreaterThan(tokens.toast);
        expect(tokens.sheet).toBeGreaterThan(tokens.drag);

        const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
        await expect(fab).toBeVisible();

        const [navZ, fabZ, toastZ] = await Promise.all([
          page.locator('.nav').evaluate((el) => Number(getComputedStyle(el).zIndex)),
          fab.evaluate((el) => Number(getComputedStyle(el).zIndex)),
          page.locator('.toast-host').evaluate((el) => Number(getComputedStyle(el).zIndex)),
        ]);
        expect(navZ).toBe(tokens.nav);
        expect(fabZ).toBe(tokens.fab);
        expect(toastZ).toBe(tokens.toast);

        await fab.click();
        const sheet = page.locator('dialog.sheet[open]');
        await expect(sheet).toBeVisible();
        const sheetZ = await sheet.evaluate((el) => Number(getComputedStyle(el).zIndex));
        expect(sheetZ).toBe(tokens.sheet);
      });
    }
  }

  test('AC3: offenes Sheet samt Backdrop liegt über Nav und FAB', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
    await fab.click();
    await expect(page.locator('dialog.sheet[open]')).toBeVisible();

    const navBox = (await page.locator('.nav').boundingBox())!;
    const fabBox = (await fab.boundingBox())!;

    const [navUnderSheet, fabUnderSheet] = await Promise.all([
      page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('dialog.sheet') != null,
        [navBox.x + navBox.width / 2, navBox.y + navBox.height / 2] as const,
      ),
      page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('dialog.sheet') != null,
        [fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2] as const,
      ),
    ]);

    expect(navUnderSheet, 'Nav sticht durch das offene Sheet').toBe(true);
    expect(fabUnderSheet, 'FAB sticht durch das offene Sheet').toBe(true);
  });

  test('AC4: ein Toast bleibt hinter einem offenen Sheet', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    // FAB first, while it's still free — an error toast would otherwise cover it,
    // and AC4 is about the sheet/toast order, not the FAB.
    const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
    await fab.click();
    await expect(page.locator('dialog.sheet[open]')).toBeVisible();

    // A real sticky error toast, same trigger as tests/toast.spec.ts's own helper:
    // five failed pushes in a row cross SYNC_ERROR_THRESHOLD and surface it via
    // sync-status.tsx — not a fabricated DOM node.
    await page.route('**/api/sync/push', (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.evaluate(() =>
      window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Bleibt hängen' } }),
    );
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__starship.sync());
    }

    const toast = page.locator('.toast--error');
    await expect(toast).toBeVisible();
    const toastBox = (await toast.boundingBox())!;

    const toastUnderSheet = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('dialog.sheet') != null,
      [toastBox.x + toastBox.width / 2, toastBox.y + toastBox.height / 2] as const,
    );

    expect(toastUnderSheet, 'Sheet liegt nicht über dem Toast, obwohl beide offen sind').toBe(true);
  });
});
