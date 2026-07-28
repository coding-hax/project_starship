import { expect, test } from '@playwright/test';
import { registerPasskey } from './helpers';

const MODULES_OFF_KEY = 'starship:modules-off';

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test('Auslieferungszustand: alle Module an, sechs Tabs sichtbar (issue #307 AC1)', async ({ page }) => {
  await page.goto('/uebersicht');

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.locator('.nav__item')).toHaveCount(6);
});

test('ein Modul abschalten blendet seinen Tab aus, ohne die übrigen zu verändern (issue #307 AC2)', async ({
  page,
}) => {
  await page.goto('/einstellungen');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });

  await expect(nav.getByRole('link', { name: 'Journal' })).toBeVisible();
  await page.getByRole('switch', { name: 'Journal' }).click();

  await expect(nav.getByRole('link', { name: 'Journal' })).toHaveCount(0);
  await expect(nav.locator('.nav__item')).toHaveCount(5);
  for (const label of ['Übersicht', 'Aufgaben', 'Gewohnheiten', 'Kalender', 'Aktivitäten']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('wieder anschalten stellt den Tab an derselben Position wieder her (issue #307 AC3)', async ({ page }) => {
  await page.goto('/einstellungen');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const labelsBefore = await nav.locator('.nav__label').allInnerTexts();

  await page.getByRole('switch', { name: 'Kalender' }).click();
  await expect(nav.getByRole('link', { name: 'Kalender' })).toHaveCount(0);

  await page.getByRole('switch', { name: 'Kalender' }).click();
  await expect(nav.locator('.nav__label')).toHaveCount(6);
  const labelsAfter = await nav.locator('.nav__label').allInnerTexts();
  expect(labelsAfter).toEqual(labelsBefore);
});

test('core-Module (Übersicht, Einstellungen) haben keinen Schalter, Einstellungen bleibt erreichbar (issue #307 AC4)', async ({
  page,
}) => {
  await page.goto('/einstellungen');

  await expect(page.getByRole('switch', { name: 'Übersicht' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Einstellungen' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Übersicht' }),
  ).toBeVisible();

  // Der Einstellungen-Einstieg selbst lebt in AppHeader, nicht in der Nav (issue #126):
  // `chrome` ist ab 768px in der Shell sichtbar, `inline` nur auf /uebersicht mobil.
  // Auf /einstellungen ist auf Mobile design-bedingt keiner der beiden sichtbar — die
  // Erreichbarkeit prüft sich von dort, wo der Einstieg tatsächlich lebt.
  await page.goto('/uebersicht');
  await expect(page.getByRole('link', { name: 'Einstellungen' })).toBeVisible();
});

test('der Zustand übersteht einen Reload (issue #307 AC5)', async ({ page }) => {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Gewohnheiten' }).click();
  await expect(page.getByRole('switch', { name: 'Gewohnheiten' })).toHaveAttribute('aria-checked', 'false');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Gewohnheiten' })).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Gewohnheiten' }),
  ).toHaveCount(0);
});

test('offline: Umschalten ist eine reine localStorage-Mutation, keine Outbox-Op (issue #307 AC6)', async ({
  page,
  context,
}) => {
  await page.goto('/einstellungen');
  await context.setOffline(true);

  await page.getByRole('switch', { name: 'Aktivitäten' }).click();
  await expect(page.getByRole('switch', { name: 'Aktivitäten' })).toHaveAttribute('aria-checked', 'false');

  const pendingSize = await page.evaluate(() => window.__starship.size());
  expect(pendingSize).toBe(0);

  await context.setOffline(false);
});

test('Dark Mode: Schalter nutzt Tokens statt Rohfarben, reduzierte Bewegung bleibt bedienbar (issue #307 AC7)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/einstellungen');

  const toggle = page.getByRole('switch', { name: 'Wetter' });
  const trackColor = await toggle.evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
  expect(trackColor).not.toBe('');
  expect(trackColor).not.toBe('rgba(0, 0, 0, 0)');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('ein zuvor abgeschaltetes Modul bleibt über einen frischen Ausschlussschlüssel hinweg konsistent (Regression, issue #307)', async ({
  page,
}) => {
  await page.evaluate(
    ({ key, off }) => localStorage.setItem(key, JSON.stringify(off)),
    { key: MODULES_OFF_KEY, off: ['aufgaben'] },
  );
  await page.goto('/uebersicht');

  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('link', { name: 'Aufgaben' })).toHaveCount(0);
  await expect(nav.locator('.nav__item')).toHaveCount(5);
});
