import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

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

  const [textAlign, fontSize, textTitle] = await Promise.all([
    title.evaluate((el) => getComputedStyle(el).textAlign),
    title.evaluate((el) => getComputedStyle(el).fontSize),
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--text-title').trim(),
    ),
  ]);
  expect(['left', 'start']).toContain(textAlign);
  expect(fontSize).toBe(textTitle);
});
