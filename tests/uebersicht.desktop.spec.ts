import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Desktop-only (issue #1020, Teil 5 von #1015, ADR-0029): die Zweispalten-
 * Anordnung, die Titelfigur-Position und die Fab-Bodenreserve existieren nur
 * ab 768px — siehe section-card.desktop.spec.ts für die Begründung, warum das
 * in einer eigenen Datei statt eines Laufzeit-`test.skip` lebt.
 */

const NOW = '2026-07-18T12:00:00.000Z';
const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedEvent(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'events', op: 'upsert', payload: p }),
    payload,
  );
}

/** DOM-Reihenfolge aus uebersicht-sections.tsx — welches Modul steckt in `block`. */
async function moduleOf(block: ReturnType<Page['locator']>): Promise<string> {
  if (await block.locator('.weather-forecast').count()) return 'wetter';
  if (await block.locator('.events-overview__next, .events-overview__empty').count())
    return 'kalender';
  if (await block.locator('#uebersicht-aufgaben-heading').count()) return 'aufgaben';
  if (await block.locator('.activity-month-strip').count()) return 'aktivitaeten';
  if (await block.locator('.habit-today').count()) return 'routinen';
  throw new Error('Unbekanntes Modul in .overview-block');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Wie jede /uebersicht-Spec (siehe uebersicht.spec.ts): die Liste kommt aus
  // IndexedDB, nie aus einem direkten fetch (CLAUDE.md-Regel 8), und der
  // Wetter-Fetch darf nie das echte Netz treffen — sonst leckt er in andere
  // Assertions (consoleErrors, networkidle).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
  await registerPasskey(page);
  await skewClock(page, NOW);
});

test('AK1: ab 768px stehen die Sektionen in zwei Spalten, die Modulreihenfolge bleibt lesbar erhalten (issue #1020)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedEvent(page, {
    title: 'Standup',
    allDay: false,
    startsAt: '2026-07-18T12:40:00.000Z',
    endsAt: '2026-07-18T13:10:00.000Z',
    startDate: null,
    endDate: null,
    category: 'arbeit',
  });
  await seedTask(page, { title: 'Aufgabe A', dueAt: NOW });
  await seedTask(page, { title: 'Aufgabe B', dueAt: NOW });

  // Wartet auf den gemeinsamen Enthüllungspunkt (issue #642) — vorher steht
  // die Fläche zwar im Layout, ist aber `visibility: hidden`.
  await expect(page.locator('.habit-today')).toBeVisible();

  const blocks = page.locator('.uebersicht__sections > .overview-block');
  const count = await blocks.count();
  expect(count, 'mindestens drei Sektionen für einen echten Zweispalten-Beleg').toBeGreaterThanOrEqual(3);

  const modules = await Promise.all(
    Array.from({ length: count }, (_, i) => moduleOf(blocks.nth(i))),
  );
  const expectedOrder = ['wetter', 'kalender', 'aufgaben', 'aktivitaeten', 'routinen'].filter((m) =>
    modules.includes(m),
  );
  expect(modules, 'Reihenfolge aus uebersicht-sections.tsx bleibt erhalten').toEqual(expectedOrder);

  const boxes = await Promise.all(Array.from({ length: count }, (_, i) => blocks.nth(i).boundingBox()));
  const xs = boxes.map((box) => Math.round(box!.x / 10) * 10);
  const columns = [...new Set(xs)];
  expect(columns, `Spalten-x-Werte: ${xs.join(', ')}`).toHaveLength(2);

  // Spalten-Balancing statt Umsortieren: nach (Spalte, y) sortiert ergibt sich
  // wieder exakt die DOM-Reihenfolge — jede Spalte liest sich von oben nach
  // unten, keine Karte springt zwischen den Spalten hin und her.
  const withColumn = boxes.map((box, i) => ({
    module: modules[i],
    column: columns.indexOf(Math.round(box!.x / 10) * 10),
    y: box!.y,
  }));
  const sortedByPosition = [...withColumn]
    .sort((a, b) => a.column - b.column || a.y - b.y)
    .map((entry) => entry.module);
  expect(sortedByPosition).toEqual(modules);
});

test('AK2: die Seitenfigur rückt ab 768px neben das Titelwort statt an den rechten Rand, die mobile Regel bleibt (issue #1020)', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  const h1 = page.locator('.uebersicht__title-cluster h1');
  const face = page.locator('.uebersicht__title-cluster svg.face');
  const cluster = page.locator('.uebersicht__title-cluster');
  await expect(h1).toBeVisible();
  await expect(face).toBeVisible();

  expect(await h1.evaluate((el) => getComputedStyle(el).flexGrow)).toBe('0');

  const [h1Box, faceBox, clusterBox] = await Promise.all([
    h1.boundingBox(),
    face.boundingBox(),
    cluster.boundingBox(),
  ]);
  // Figur sitzt dicht rechts des Titeltexts — der Lückenabstand ist `--space-2` (8px).
  const gapToFace = faceBox!.x - (h1Box!.x + h1Box!.width);
  expect(gapToFace, `Lücke Titel→Figur: ${gapToFace}px`).toBeGreaterThanOrEqual(4);
  expect(gapToFace, `Lücke Titel→Figur: ${gapToFace}px`).toBeLessThan(20);
  // … und rechts davon bleibt deutlich Leerraum bis zum Cluster-Rand, statt dass
  // die Figur an ihn gedrückt wird (AK2: „neben dem Titelwort statt am rechten Rand").
  const trailingSpace = clusterBox!.x + clusterBox!.width - (faceBox!.x + faceBox!.width);
  expect(trailingSpace, `Leerraum rechts der Figur: ${trailingSpace}px`).toBeGreaterThan(100);

  // Die mobile Regel (Font-Swap-Schutz #652/#862) bleibt außerhalb dieses
  // Blocks unverändert stehen — der Override hier ist media-gescoped.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await h1.evaluate((el) => getComputedStyle(el).flexGrow)).toBe('1');
});

test('AK3: der Fab verdeckt auf Desktop keinen Inhalt am unteren Seitenrand (issue #1020)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  for (let i = 0; i < 20; i += 1) {
    await seedTask(page, { title: `Aufgabe ${i}`, dueAt: NOW });
  }

  await expect(page.locator('.habit-today')).toBeVisible();

  const sectionsPaddingBottom = await page
    .locator('.uebersicht__sections')
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(sectionsPaddingBottom, 'AK3 reserviert Bodenabstand für den Fab').toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  const blocks = page.locator('.uebersicht__sections > .overview-block');
  const count = await blocks.count();
  const boxes = await Promise.all(Array.from({ length: count }, (_, i) => blocks.nth(i).boundingBox()));
  // Unterster Rand über beide Spalten hinweg — bei Spalten-Balancing kann das
  // DOM-letzte Element (Routinen) in der kürzeren Spalte landen, nicht in der
  // visuell untersten.
  const maxBottom = Math.max(...boxes.map((box) => box!.y + box!.height));

  const fabBox = await page.locator('.fab').boundingBox();
  expect(maxBottom, 'unterster Sektionsrand bleibt oberhalb des Fab').toBeLessThanOrEqual(fabBox!.y);
});
