import { expect, test, type Locator, type Page } from '@playwright/test';
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

  // Issue #653 AK2 stuft Kartentitel bewusst unter die Gruppenüberschrift zurück
  // (--text-section bleibt der Gruppe vorbehalten) — löst die AC3-Vorgabe von #651 ab.
  test('AC3 (überholt durch #653 AK2): .section-card__title rendert in --text-secondary auf /einstellungen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const title = page.locator('.section-card__title').first();
    const [fontSize, textSecondary] = await Promise.all([
      title.evaluate((el) => getComputedStyle(el).fontSize),
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(),
      ),
    ]);
    expect(fontSize).toBe(textSecondary);
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

/**
 * Issue #709: --accent-fg war fast weiß und unterschritt auf allen vier
 * Bereichsfarben WCAG AA (4,5:1) im Hellmodus. --on-accent (immer dunkel,
 * gleicher Wert in beiden Themes) ersetzt es auf FAB und den Submit-Knöpfen
 * der vier Editoren (Aufgabe/Termin/Routine/Journal).
 */
test.describe('Design-System: --on-accent Kontrast (issue #709)', () => {
  function srgbToLinear(channel: number): number {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(rgb: [number, number, number]): number {
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * getComputedStyle can serialize an oklch()-declared colour back as oklch()
   * rather than rgb() (CSS Color 4) — a regex expecting "rgb(r, g, b)" would
   * silently misparse the L/C/H numbers as R/G/B. A 1×1 canvas sidesteps that:
   * its 2D context is always sRGB, so reading the pixel back after setting
   * fillStyle gives real 0–255 channels regardless of the source syntax.
   */
  async function contrastOf(locator: Locator): Promise<number> {
    const [fg, bg] = await locator.evaluate((el) => {
      const style = getComputedStyle(el);
      const toRgb = (color: string): [number, number, number] => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      };
      return [toRgb(style.color), toRgb(style.backgroundColor)] as const;
    });
    return contrastRatio(fg, bg);
  }

  async function setTheme(page: Page, theme: 'hell' | 'dunkel') {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  }

  const themes = ['hell', 'dunkel'] as const;

  for (const theme of themes) {
    test(`AC3: FAB erreicht mindestens 4,5:1 Kontrast (${theme})`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto('/aufgaben');
      await setTheme(page, theme);

      const fab = page.getByRole('button', { name: 'Aufgabe erfassen' });
      await expect(fab).toBeVisible();
      expect(await contrastOf(fab)).toBeGreaterThanOrEqual(4.5);
    });

    test(`AC3: Aufgabe-Submit erreicht mindestens 4,5:1 Kontrast (${theme})`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto('/aufgaben');
      await setTheme(page, theme);
      // The FAB opens quick-add.tsx (its own, unrelated submit button) — the
      // .task-editor__submit this ticket fixed only exists in the edit sheet,
      // reached by tapping an existing task (same as tests/tasks.spec.ts).
      await page.evaluate(() =>
        window.__starship.mutate({
          table: 'tasks',
          op: 'upsert',
          payload: { title: 'Kontrast-Test-709' },
        }),
      );
      await page
        .getByRole('list', { name: 'Aufgaben' })
        .getByRole('listitem')
        .filter({ hasText: 'Kontrast-Test-709' })
        .click();

      const submit = page.getByRole('dialog', { name: 'Aufgabe bearbeiten' }).locator('.task-editor__submit');
      await expect(submit).toBeVisible();
      expect(await contrastOf(submit)).toBeGreaterThanOrEqual(4.5);
    });

    test(`AC3: Termin-Submit erreicht mindestens 4,5:1 Kontrast (${theme})`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto('/kalender');
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Termin erfassen' }).click();

      const submit = page.locator('.event-editor__submit');
      await expect(submit).toBeVisible();
      expect(await contrastOf(submit)).toBeGreaterThanOrEqual(4.5);
    });

    test(`AC3: Routine-Submit erreicht mindestens 4,5:1 Kontrast (${theme})`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto('/routinen');
      await setTheme(page, theme);
      await page.getByRole('button', { name: 'Routine anlegen' }).click();

      // habit-list.tsx always mounts a second (closed) HabitEditor in edit mode
      // alongside this one — scope to the open create dialog or the bare class
      // selector hits Playwright's strict-mode "2 elements" error.
      const submit = page.getByRole('dialog', { name: 'Routine anlegen' }).locator('.habit-editor__submit');
      await expect(submit).toBeVisible();
      expect(await contrastOf(submit)).toBeGreaterThanOrEqual(4.5);
    });

    test(`AC3: Journal-Submit erreicht mindestens 4,5:1 Kontrast (${theme})`, async ({ page }) => {
      await registerPasskey(page);
      await page.goto('/journal');
      await setTheme(page, theme);

      await page.getByLabel('Passphrase', { exact: true }).fill('Kontrast-Test-709');
      await page.getByLabel('Passphrase wiederholen').fill('Kontrast-Test-709');
      await page.getByRole('button', { name: 'Einrichten' }).click();
      await page.getByTestId('journal-recovery-key').waitFor();
      await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
      await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

      // #701: das Formular sitzt jetzt im FAB-Sheet, nicht mehr direkt auf der
      // Seite — die FAB trägt denselben Namen wie der Sheet-eigene Knopf, im
      // offenen (modalen) Sheet ist die FAB dahinter aber inert.
      await page.getByRole('button', { name: 'Eintragen', exact: true }).click();
      // journal-entry-sheet.tsx only renders .journal-editor__submit once the
      // form has content (mood or text) — an empty form has nothing to submit.
      await page.getByLabel('Journal-Text').fill('Kontrast-Test-709');

      const submit = page.getByRole('dialog', { name: 'Eintragen' }).locator('.journal-editor__submit');
      await expect(submit).toBeVisible();
      expect(await contrastOf(submit)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
