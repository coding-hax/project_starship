import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

test('Bewegung reduzieren schaltet den Toggle und bleibt nach Reload erhalten', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Bewegung reduzieren' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
});

test('SegmentedControl wählt das Theme, setzt es auf <html> und reagiert auf Pfeiltasten', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const dunkel = page.getByRole('radio', { name: 'Dunkel' });
  await dunkel.click();
  await expect(dunkel).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dunkel');
  const bgDark = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg'),
  );

  const hell = page.getByRole('radio', { name: 'Hell' });
  await hell.click();
  await expect(hell).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'hell');
  const bgLight = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg'),
  );
  expect(bgLight).not.toBe(bgDark);

  await hell.focus();
  await page.keyboard.press('ArrowRight');
  const dunkelAgain = page.getByRole('radio', { name: 'Dunkel' });
  await expect(dunkelAgain).toBeFocused();
  await expect(dunkelAgain).toHaveAttribute('aria-checked', 'true');
});

test('der Slider ändert die Textgröße per Tastatur', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const slider = page.getByRole('slider', { name: 'Textgröße' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'Standard');
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-scale'),
  );

  await slider.focus();
  await page.keyboard.press('ArrowRight');

  await expect(slider).toHaveAttribute('aria-valuetext', 'Groß');
  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-scale'),
  );
  expect(Number(after)).toBeGreaterThan(Number(before));
});

test('Theme, Toggle und Slider sind fokussierbar, Space schaltet den Toggle, der Fokus ist sichtbar', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const themeOption = page.getByRole('radio', { name: 'System' });
  await themeOption.focus();
  await expect(themeOption).toBeFocused();
  await expect(themeOption).toHaveCSS('outline-style', 'solid');

  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS('outline-style', 'solid');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const slider = page.getByRole('slider', { name: 'Textgröße' });
  await slider.focus();
  await expect(slider).toBeFocused();
});

test.describe('reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('der Toggle wechselt zuverlässig ohne Bewegungsabhängigkeit', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });
});

test('die Open-Meteo-Quellenangabe steht in den Einstellungen und ist von dort erreichbar (issue #155 AC5)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const link = page.getByRole('link', { name: 'Open-Meteo' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://open-meteo.com/');
});

test('die Einstellungen-Primitive tragen keine teuren Filter (60-fps-Versprechen)', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const selectors = ['.row', '.section-card', '.toggle', '.segmented', '.slider'];
  for (const selector of selectors) {
    const computedFilters = await page
      .locator(selector)
      .evaluateAll((elements) =>
        elements.map((el) => {
          const style = getComputedStyle(el);
          return { filter: style.filter, backdropFilter: style.backdropFilter };
        }),
      );
    expect(computedFilters.length).toBeGreaterThan(0);
    for (const { filter, backdropFilter } of computedFilters) {
      expect(filter).toBe('none');
      expect(backdropFilter).toBe('none');
    }
  }
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`Zurück-Link führt zur Übersicht, Titel steht auf gleicher Höhe rechts (${viewport.width}px, issue #288 AC1)`, async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.setViewportSize(viewport);
    await page.goto('/einstellungen');

    const back = page.locator('.einstellungen__back');
    await expect(back).toBeVisible();
    await expect(back).toHaveText('Übersicht');

    const backBox = await back.boundingBox();
    const titleBox = await page.getByRole('heading', { level: 1 }).boundingBox();
    expect(titleBox!.x).toBeGreaterThan(backBox!.x + backBox!.width);
    // „auf gleicher Höhe" heißt: die Mitten liegen übereinander, nicht untereinander.
    expect(
      Math.abs(titleBox!.y + titleBox!.height / 2 - (backBox!.y + backBox!.height / 2)),
    ).toBeLessThan(8);

    await back.click();
    await expect(page).toHaveURL('/uebersicht');
  });
}

test('AC2 (issue #651): der Seitentitel auf /einstellungen ist linksbündig, ohne eigenen font-size', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const title = page.locator('.einstellungen__title');
  await expect(title).toBeVisible();

  // Seit issue #833 trägt der globale h1-Stil --text-page-title (22px), nicht
  // mehr --text-title (32px, bleibt für FAB-Glyphe/Termin-Detail) — die
  // ursprüngliche Aussage von AC2 ("kein eigener font-size") gilt weiter, nur
  // die Referenzrolle hat sich verschoben.
  const [textAlign, fontSize, pageTitleSize] = await Promise.all([
    title.evaluate((el) => getComputedStyle(el).textAlign),
    title.evaluate((el) => getComputedStyle(el).fontSize),
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text-page-title').trim(),
    ),
  ]);
  expect(['left', 'start']).toContain(textAlign);
  expect(fontSize).toBe(pageTitleSize);
});

test('AC1 (issue #653): drei Gruppenüberschriften sind sichtbar und stehen in der erwarteten Reihenfolge', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const groupTitles = page.locator('.einstellungen__group-title');
  await expect(groupTitles).toHaveText(['Gerät', 'Module', 'Daten']);
});

test('AC2 (issue #653): ein Kartentitel rendert kleiner als seine Gruppenüberschrift', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const groupTitle = page.locator('.einstellungen__group-title').first();
  const cardTitle = page.locator('.section-card__title').first();
  await expect(groupTitle).toBeVisible();
  await expect(cardTitle).toBeVisible();

  const [groupSize, cardSize] = await Promise.all([
    groupTitle.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    cardTitle.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ]);
  expect(cardSize).toBeLessThan(groupSize);
});

test('AC3 (issue #653): das Export-Panel liegt in einer .section-card', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const exportCard = page.locator('.section-card.export');
  await expect(exportCard).toBeVisible();
  await expect(exportCard.getByRole('button', { name: 'Alles exportieren' })).toBeVisible();
});

test('AC4 (issue #653): .row trennt mit --border-faint statt --border', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const { rowColor, faintColor, borderColor } = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.borderBottom = '1px solid var(--border-faint)';
    const faintColor = getComputedStyle(probe).borderBottomColor;
    probe.style.borderBottom = '1px solid var(--border)';
    const borderColor = getComputedStyle(probe).borderBottomColor;
    probe.remove();
    const row = document.querySelector('.row');
    return { rowColor: row ? getComputedStyle(row).borderBottomColor : null, faintColor, borderColor };
  });

  expect(rowColor).toBe(faintColor);
  expect(rowColor).not.toBe(borderColor);
});

test('AC6 (issue #653): ein abgeschaltetes Modul verbirgt sein Panel, eine leer gewordene Gruppe verliert auch ihre Überschrift', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/einstellungen');

  const groupTitles = page.locator('.einstellungen__group-title');
  await expect(groupTitles).toHaveText(['Gerät', 'Module', 'Daten']);

  // Journal ist eines von mehreren Panels der Gruppe „Module" — nur das Panel
  // verschwindet, die Gruppenüberschrift bleibt.
  await expect(page.getByRole('heading', { name: 'Journal', level: 2 })).toBeVisible();
  await page.getByRole('switch', { name: 'Journal' }).click();
  await expect(page.getByRole('heading', { name: 'Journal', level: 2 })).toHaveCount(0);
  await expect(groupTitles).toHaveText(['Gerät', 'Module', 'Daten']);

  // Export ist das einzige Panel der Gruppe „Daten" — mit ihm verschwindet auch
  // die Gruppenüberschrift.
  await page.getByRole('switch', { name: 'Export' }).click();
  await expect(page.locator('.section-card.export')).toHaveCount(0);
  await expect(groupTitles).toHaveText(['Gerät', 'Module']);
});

/* -------------------------------------------------------------------------- */
/* issue #660: Kategoriefarben selbst wählen                                  */
/* -------------------------------------------------------------------------- */

function categoryColorsPanel(page: Page) {
  return page.locator('.section-card').filter({ has: page.getByRole('heading', { name: 'Kategoriefarben', level: 2 } ) });
}

function categoryRow(page: Page, label: string) {
  return categoryColorsPanel(page)
    .locator('.category-colors-panel__category')
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function categoryColorFromDb(category: string): Promise<string | null> {
  // deleted_at IS NULL: reset() soft-deletes (push/route.ts), it does not clear
  // `color` (NOT NULL column) — the row's last color survives the tombstone, so a
  // query without this filter would see the stale value instead of "no override"
  // (same convention as journal.spec.ts/offline-critical.spec.ts).
  const result = await withDb((client) =>
    client.query('SELECT color FROM category_colors WHERE category = $1 AND deleted_at IS NULL', [category]),
  );
  return result.rowCount === 0 ? null : (result.rows[0].color as string);
}

test.describe('Kategoriefarben (issue #660)', () => {
  test.beforeEach(async ({ page }) => {
    // Das Panel liest ausschließlich aus IndexedDB (CLAUDE.md Regel 8) — Sync
    // gekappt beweist das, gleiche Konvention wie reminder-prefs.spec.ts.
    await page.route('**/api/sync/**', (route) => route.abort('failed'));
  });

  test('AK1: das Panel „Kategoriefarben" steht unter „Module", solange Kalender aktiv ist', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const moduleGroup = page
      .locator('.einstellungen__group')
      .filter({ has: page.locator('.einstellungen__group-title', { hasText: 'Module' }) });
    await expect(moduleGroup.getByRole('heading', { name: 'Kategoriefarben', level: 2 })).toBeVisible();

    await page.getByRole('switch', { name: 'Kalender' }).click();
    await expect(page.getByRole('heading', { name: 'Kategoriefarben', level: 2 })).toHaveCount(0);
  });

  test('AK2: das Panel listet alle fünf Kategorien mit Namen und ihrer aktuellen Farbe', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const panel = categoryColorsPanel(page);
    await expect(panel.locator('.category-colors-panel__category')).toHaveCount(5);
    for (const label of ['Privat', 'Arbeit', 'Gesundheit', 'Sport', 'Familie']) {
      await expect(categoryRow(page, label)).toBeVisible();
    }

    // Ohne Override zeigt die Vorschau exakt den heutigen --cat-arbeit-Wert.
    const expected = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--cat-arbeit)';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    const preview = categoryRow(page, 'Arbeit').locator('.category-colors-panel__current');
    await expect
      .poll(() => preview.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(expected);
  });

  test('AK3: eine Farbe aus der Zehnerpalette lässt sich je Kategorie wählen', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    // .click() statt .check(): der Radio-Status haengt am IndexedDB-Roundtrip
    // ueber useLiveTable, .check() prueft den Haken-Status einmalig direkt
    // nach dem Klick und wartet nicht darauf (gleiche Konvention wie
    // reminder-prefs.spec.ts' Toggle-Klicks).
    const swatch = categoryRow(page, 'Arbeit').getByRole('radio', { name: 'Arbeit: Bernstein' });
    await swatch.click();
    await expect(swatch).toBeChecked();

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => categoryColorFromDb('arbeit')).toBe('--swatch-amber');
  });

  test('AK6: ein Reset-Weg führt je Kategorie zurück auf den Default', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const arbeitRow = categoryRow(page, 'Arbeit');
    await arbeitRow.getByRole('radio', { name: 'Arbeit: Bernstein' }).click();
    const resetButton = arbeitRow.getByRole('button', { name: 'Arbeit: Standardfarbe verwenden' });
    await expect(resetButton).toBeVisible();

    await resetButton.click();
    await expect(arbeitRow.getByRole('radio', { name: 'Arbeit: Bernstein' })).not.toBeChecked();
    await expect(resetButton).toHaveCount(0);

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => categoryColorFromDb('arbeit')).toBeNull();
  });

  test('AK8: zwei Kategorien mit derselben Farbe zeigen das sichtbar an', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    await categoryRow(page, 'Arbeit').getByRole('radio', { name: 'Arbeit: Bernstein' }).click();
    await categoryRow(page, 'Sport').getByRole('radio', { name: 'Sport: Bernstein' }).click();

    await expect(categoryRow(page, 'Arbeit')).toContainText('Farbe auch bei: Sport');
    await expect(categoryRow(page, 'Sport')).toContainText('Farbe auch bei: Arbeit');
    // Eine Kategorie ohne geteilte Farbe zeigt keinen Hinweis.
    await expect(categoryRow(page, 'Privat').getByText('Farbe auch bei')).toHaveCount(0);
  });

  test('AK9: offline gewählte Kategoriefarbe erreicht online die Datenbank', async ({ page, context }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');
    await context.setOffline(true);

    await categoryRow(page, 'Familie').getByRole('radio', { name: 'Familie: Rosé' }).click();
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

    // Reihenfolge wie in habits.spec.ts/reminder-prefs.spec.ts: erst entrouten,
    // dann online — sonst wettläuft der App-eigene 'online'-Listener gegen das Unroute.
    await page.unroute('**/api/sync/**');
    await context.setOffline(false);
    await page.evaluate(() => window.__starship.sync());

    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
    await expect.poll(() => categoryColorFromDb('familie')).toBe('--swatch-rose');
  });
});
