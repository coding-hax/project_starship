import { expect, test } from '@playwright/test';
import { registerPasskey } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1116, ADR-0030): 264er Leiste, zentrierte 1440er
 * Inhaltsspalte, Einstellungs-Einstieg im Leistenfuß, FAB an der Inhaltsspalte
 * statt am Fensterrand. Läuft im `desktop-wide`-Messplatz (1800 × 1000, issue
 * #1115) — die zweite Stufe (768–1439px) bleibt unverändert und wird von
 * `shell.desktop.spec.ts` (1280px) geprüft, hier absichtlich nicht doppelt.
 */

test('AK1: `.shell` hat eine 264er erste Spalte, `.shell__main` eine zentrierte 1440er Spalte (issue #1116)', async ({
  page,
}) => {
  await registerPasskey(page, '/uebersicht');

  const columns = await page
    .locator('.shell')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(columns.split(' ')[0]).toBe('264px');

  const main = await page.locator('main.shell__main').evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      maxWidth: cs.maxWidth,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      marginLeft: cs.marginLeft,
      marginRight: cs.marginRight,
    };
  });
  expect(main.maxWidth).toBe('1440px');
  expect(main.paddingLeft).toBe('48px'); // var(--space-12)
  expect(main.paddingRight).toBe('48px');
  // margin-inline: auto — beide Seiten gleich groß, (1800 - 264 - 1440) / 2 = 48px.
  expect(main.marginLeft).toBe(main.marginRight);
  expect(main.marginLeft).toBe('48px');
});

test('AK3: Einstellungs-Einstieg sitzt im Leistenfuß mit sichtbarem Text (issue #1116)', async ({ page }) => {
  await registerPasskey(page, '/aufgaben');

  // `chrome` ist ab 1440px versteckt (shell.css) — es darf nur diesen einen
  // erreichbaren „Einstellungen"-Link geben, sonst wäre das ein strict-mode-Fund.
  const settings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(settings).toHaveCount(1);
  await expect(settings).toBeVisible();

  const settingsBox = await settings.boundingBox();
  const lastNavItem = page.locator('.nav__item').last();
  const navBox = await lastNavItem.boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(navBox).not.toBeNull();

  expect(Math.round(settingsBox!.x)).toBe(0);
  expect(Math.round(settingsBox!.width)).toBe(264);
  expect(settingsBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height);

  // Echter Text, kein `content:`-Pseudoelement — `.textContent()` erreicht nur
  // echte Textknoten, generierter Inhalt eines ::before/::after taucht dort nie auf.
  const label = settings.locator('.app-header__label');
  await expect(label).toBeVisible();
  await expect(label).toHaveText('Einstellungen');
});

test('AK4: rechte Kante des FAB folgt der Inhaltsspalte, nicht dem Fensterrand (issue #1116)', async ({ page }) => {
  await registerPasskey(page, '/aufgaben');

  const [mainBox, fabBox] = await Promise.all([
    page.locator('main.shell__main').boundingBox(),
    page.locator('.fab').boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(fabBox).not.toBeNull();

  const contentRightEdge = mainBox!.x + mainBox!.width;
  const fabRightEdge = fabBox!.x + fabBox!.width;
  expect(fabRightEdge - contentRightEdge).toBeLessThanOrEqual(24); // var(--space-6)
});

test('AK5: kein horizontaler Überlauf bei 1800px und 1920px (issue #1116, vormals #1115)', async ({ page }) => {
  await registerPasskey(page, '/uebersicht');

  for (const width of [1800, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, `bei ${width}px`).toBeLessThanOrEqual(width);
  }
});
