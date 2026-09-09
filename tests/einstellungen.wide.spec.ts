import { expect, test, type Locator } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1129, Nachfolger von #1117): ab 1440px läuft
 * das Kartenfeld durchgehend über drei Bahnen statt gruppenweise unter einer
 * Überschrift zu stehen. Läuft im `desktop-wide`-Messplatz (1800 × 1000,
 * playwright.config.ts), wie aufgaben.wide.spec.ts. Die gestapelte Form mit
 * sichtbaren Überschriften bei 1280px/375px bleibt unverändert (AC6) — dafür
 * bürgt settings.spec.ts weiter (läuft nur im `mobile`-Messplatz).
 */

test.beforeEach(async () => {
  await resetAppData();
});

async function boundingBoxesOf(locator: Locator) {
  const count = await locator.count();
  const boxes = [];
  for (let i = 0; i < count; i += 1) {
    const box = await locator.nth(i).boundingBox();
    if (!box) throw new Error('Element ohne Bounding-Box');
    boxes.push(box);
  }
  return boxes;
}

test('AC1: Karten laufen über drei Bahnen, keine Karte reißt an einer Bahnengrenze auf', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const groups = page.locator('.einstellungen__groups');
  await expect(groups).toHaveCSS('column-count', '3');

  const cards = page.locator('.section-card');
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(6);

  for (let i = 0; i < cardCount; i += 1) {
    await expect(cards.nth(i)).toHaveCSS('break-inside', 'avoid');
  }

  // Tatsächlich mehrere Bahnen im Einsatz, nicht bloß eine mit Leerraum daneben.
  const xs = (await boundingBoxesOf(cards)).map((box) => Math.round(box.x));
  expect(new Set(xs).size).toBeGreaterThanOrEqual(3);
});

test('AC2: Gruppenüberschriften bleiben im DOM und in der Vorlese-Reihenfolge, verschwinden aber fürs Auge', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const groupTitles = page.locator('.einstellungen__group-title');
  await expect(groupTitles).toHaveText(['Gerät', 'Module', 'Daten']);

  const count = await groupTitles.count();
  for (let i = 0; i < count; i += 1) {
    const title = groupTitles.nth(i);
    // `.visually-hidden`-Rezept: im DOM, ohne sichtbare Ausdehnung — nicht
    // `display: none`, sonst verschwände die Überschrift auch aus dem
    // Accessibility-Tree/der Vorlese-Reihenfolge.
    await expect(title).toHaveCSS('display', 'block');
    const box = await title.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(1);
    expect(box!.height).toBeLessThanOrEqual(1);
    // Weiterhin als <h2> im Accessibility-Tree ansprechbar — page-weites
    // getByRole('heading', { name }) wäre hier mehrdeutig: „Module" ist auch
    // der Kartentitel des gleichnamigen Panels (section-card__title).
    await expect(title).toHaveRole('heading');
  }
});

test('AC3: Zurück-Link links, Titel+Figur rechts, in einer Zeile', async ({ page }) => {
  await registerPasskey(page, '/einstellungen');

  const back = page.locator('.einstellungen__back');
  const titleCluster = page.locator('.einstellungen__title-cluster');
  await expect(back).toBeVisible();
  await expect(titleCluster).toBeVisible();

  const backBox = await back.boundingBox();
  const clusterBox = await titleCluster.boundingBox();
  expect(clusterBox!.x).toBeGreaterThan(backBox!.x + backBox!.width);
  // Vertikal überlappend statt untereinander — eine Zeile.
  expect(clusterBox!.y).toBeLessThan(backBox!.y + backBox!.height);
  expect(clusterBox!.y + clusterBox!.height).toBeGreaterThan(backBox!.y);
});

test('AC4: der Theme-Umschalter behält seine Mindestbreite, „System" wird nicht beschnitten', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  const system = page.getByRole('radio', { name: 'System' });
  await expect(system).toBeVisible();
  await expect(system).toHaveText('System');

  const segmented = page.locator('.segmented').first();
  const [scrollWidth, clientWidth] = await segmented.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth, 'Umschalter läuft über die eigene Box hinaus (würde beschnitten)').toBeLessThanOrEqual(
    clientWidth,
  );

  // Einzeilig statt auf zwei Zeilen umgebrochen — Höhe bleibt bei der
  // Touch-Target-Zeile (--touch-target, 44px) statt zu wachsen.
  const optionBox = await system.boundingBox();
  expect(optionBox!.height).toBeLessThan(48);
});

test('AC5: ein abgeschaltetes Modul lässt keine Lücke im Feld', async ({ page }) => {
  await registerPasskey(page, '/einstellungen');

  await expect(page.getByRole('heading', { name: 'Journal', level: 2 })).toBeAttached();
  await page.getByRole('switch', { name: 'Journal' }).click();
  await expect(page.getByRole('heading', { name: 'Journal', level: 2 })).toHaveCount(0);

  const boxes = await boundingBoxesOf(page.locator('.section-card'));

  // Karten nach Bahn (x-Position, auf 2px gebündelt gegen Subpixel-Rundung)
  // gruppieren, je Bahn nach y sortieren: eine verschwundene Karte müsste eine
  // deutlich größere Lücke als den üblichen Kartenabstand (--space-3, 12px)
  // reißen — das balancierte `columns`-Layout schließt sie stattdessen.
  const byColumn = new Map<number, typeof boxes>();
  for (const box of boxes) {
    const bucket = Math.round(box.x / 2) * 2;
    const list = byColumn.get(bucket) ?? [];
    list.push(box);
    byColumn.set(bucket, list);
  }
  expect(byColumn.size).toBeGreaterThanOrEqual(3);

  for (const list of byColumn.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i].y - (list[i - 1].y + list[i - 1].height);
      expect(gap).toBeLessThan(20);
    }
  }
});

test('AC6: bei 1280px und 375px bleiben die Gruppen mit sichtbaren Überschriften gestapelt', async ({
  page,
}) => {
  await registerPasskey(page, '/einstellungen');

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);

    await expect(
      page.locator('.einstellungen__groups'),
      `${viewport.width}px: .einstellungen__groups läuft schon spaltig`,
    ).toHaveCSS('display', 'flex');

    const groupTitles = page.locator('.einstellungen__group-title');
    await expect(groupTitles).toHaveText(['Gerät', 'Module', 'Daten']);
    const count = await groupTitles.count();
    for (let i = 0; i < count; i += 1) {
      await expect(groupTitles.nth(i)).toBeVisible();
    }
  }
});
