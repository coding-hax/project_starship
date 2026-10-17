import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXED_NOW,
  installClockAt,
  openMeteoForecastBody,
  registerPasskey,
  resetAppData,
} from './helpers';

/**
 * Dritte Desktop-Stufe (issue #1117, Nachfolger von #1116): ab 1440px rückt
 * der Seitenkopf in eine Zeile zusammen — Augenbraue + Zusatz-Slot links,
 * Titelzeile rechts. Läuft im `desktop-wide`-Messplatz (1800 × 1000,
 * playwright.config.ts), wie shell.wide.spec.ts. Die gestapelte Form bei
 * 768–1439px/375px bleibt unverändert — dafür bürgt seitenkopf.spec.ts (läuft
 * nur im `mobile`-Messplatz), AK6 unten prüft zusätzlich gezielt, dass die
 * neue Regel unterhalb von 1440px gar nicht erst greift.
 *
 * /uebersicht ist seit issue #1180 keine Instanz dieser Regel mehr (ADR-0030,
 * Nachtrag 10.09.2026) — eigene Zeile aus vier statt zwei Zonen, Titelzeile
 * mittig statt rechtsbündig. Deren eigene Zeilen-Assertions stehen in
 * uebersicht-progress-ring.wide.spec.ts, hier taucht die Route deshalb nicht
 * mehr auf.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const FORECAST_WEEK = [
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
  '2026-07-18',
  '2026-07-19',
  '2026-07-20',
  '2026-07-21',
];
const PASSPHRASE = 'Seitenkopf-1117-Passphrase';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // /uebersicht löst beim Laden einen echten Netzaufruf aus, der ungemockt als
  // Konsolenfehler/Dev-Overlay im DOM landet (wie seitenkopf.spec.ts).
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({
        dates: FORECAST_WEEK,
        tempsMax: FORECAST_WEEK.map(() => 20),
        tempsMin: FORECAST_WEEK.map(() => 10),
      }),
    }),
  );
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function setUpJournal(page: Page, passphrase: string) {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/** `main.shell__main`'s own box, not the Inhaltsspalte — ab 1440px trägt
 * `.shell__main` selbst ein `padding-inline: var(--space-12)` (48px, shell.css
 * #1116), innerhalb dessen Kinder wie `.page-head` rendern. Die Inhaltsspalte,
 * an der AK1/AK2 die Kanten misst, ist deshalb `main`s Innenkante, nicht seine
 * eigene Randbox. */
async function contentColumnBox(page: Page) {
  const main = page.locator('main.shell__main');
  const [box, padding] = await Promise.all([
    main.boundingBox(),
    main.evaluate((el) => {
      const style = getComputedStyle(el);
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    }),
  ]);
  if (!box) throw new Error('main.shell__main hat keine Bounding Box');
  return {
    x: box.x + padding.left,
    y: box.y,
    width: box.width - padding.left - padding.right,
    height: box.height,
  };
}

/** AK1/AK2: Augenbraue, Zusatz (falls vorhanden) und Titelzeile teilen eine
 * Zeile — vertikale Mitten höchstens 4px auseinander — und die Zeile spannt
 * bündig über die ganze Inhaltsspalte (Augenbraue links, Titelzeile rechts). */
async function assertOneRow(
  page: Page,
  path: string,
  locators: { eyebrow: Locator; titleRow: Locator; extra?: Locator },
) {
  await expect(locators.eyebrow, `${path}: Augenbraue`).toBeVisible();
  await expect(locators.titleRow, `${path}: Titelzeile`).toBeVisible();

  const main = await contentColumnBox(page);
  const boxes = [(await locators.eyebrow.boundingBox())!, (await locators.titleRow.boundingBox())!];
  if (locators.extra) {
    await expect(locators.extra, `${path}: Zusatz-Slot`).toBeVisible();
    boxes.push((await locators.extra.boundingBox())!);
  }

  const centers = boxes.map((box) => box.y + box.height / 2);
  const delta = Math.max(...centers) - Math.min(...centers);
  expect(delta, `${path}: vertikale Mitten weichen ${delta}px voneinander ab`).toBeLessThanOrEqual(4);

  const [eyebrowBox, titleBox] = boxes;
  expect(Math.round(eyebrowBox.x), `${path}: Augenbraue beginnt nicht an der linken Kante`).toBe(
    Math.round(main.x),
  );
  const titleRightEdge = titleBox.x + titleBox.width;
  const mainRightEdge = main.x + main.width;
  expect(
    Math.abs(titleRightEdge - mainRightEdge),
    `${path}: Titelzeile endet nicht bündig rechts (${titleRightEdge} vs. ${mainRightEdge})`,
  ).toBeLessThanOrEqual(1);
}

/** AK5: Seitentitel auf --text-title (32px), Figur auf 60×60px. */
async function assertTitleTokenAndFace(page: Page, path: string, titleRow: Locator) {
  const h1 = titleRow.locator('h1');
  const face = titleRow.locator('.face');
  await expect(h1, `${path}: h1`).toBeVisible();
  await expect(face, `${path}: Figur`).toBeVisible();

  const [fontSize, titleToken, faceBox] = await Promise.all([
    h1.evaluate((el) => getComputedStyle(el).fontSize),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-title').trim()),
    face.boundingBox(),
  ]);
  expect(fontSize, `${path}: Titelgröße`).toBe(titleToken);
  expect(Math.round(faceBox!.width), `${path}: Figurbreite`).toBe(60);
  expect(Math.round(faceBox!.height), `${path}: Figurhöhe`).toBe(60);
}

test('AK1/AK2/AK5: Aufgaben, Routinen und Aktivitäten laufen in einer Zeile, bündig zur Inhaltsspalte, mit --text-title/60px-Figur', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page, '/aufgaben');
  await seedTask(page, { title: 'Breite Aufgabe', dueAt: null });

  const cases: Array<{
    path: string;
    eyebrow: (page: Page) => Locator;
    titleRow: (page: Page) => Locator;
    extra?: (page: Page) => Locator;
  }> = [
    {
      path: '/aufgaben',
      eyebrow: (p) => p.locator("[data-ground='aufgaben'] .page-head__eyebrow"),
      titleRow: (p) => p.locator('.aufgaben-page__title-row'),
      extra: (p) => p.locator("[data-ground='aufgaben'] .page-head__extra"),
    },
    {
      path: '/routinen',
      eyebrow: (p) => p.locator("[data-ground='routinen'] .page-head__eyebrow"),
      titleRow: (p) => p.locator("[data-ground='routinen'] .page-face-row"),
    },
  ];

  for (const { path, eyebrow, titleRow, extra } of cases) {
    await page.goto(path);
    const locators = { eyebrow: eyebrow(page), titleRow: titleRow(page), extra: extra?.(page) };
    await assertOneRow(page, path, locators);
    await assertTitleTokenAndFace(page, path, locators.titleRow);
  }
});

test('AK1/AK2/AK4/AK5: Journal läuft in einer Zeile inkl. Lupe, mit --text-title/60px-Figur', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await setUpJournal(page, PASSPHRASE);

  const eyebrow = page.locator("[data-ground='journal'] .page-head__eyebrow");
  const titleRow = page.locator('.journal-page__title-row');
  await assertOneRow(page, '/journal', { eyebrow, titleRow });
  await assertTitleTokenAndFace(page, '/journal', titleRow);

  // AK4: die Lupe (in der Augenbraue, journal-search-toggle.tsx) sitzt in
  // derselben Zeile wie Titel und Figur — dieselbe ±4px-Mitten-Toleranz wie AK1.
  const lupe = page.locator('.journal-page__search-toggle');
  await expect(lupe).toBeVisible();
  const [lupeBox, titleBox] = await Promise.all([lupe.boundingBox(), titleRow.boundingBox()]);
  expect(lupeBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  const lupeCenter = lupeBox!.y + lupeBox!.height / 2;
  const titleCenter = titleBox!.y + titleBox!.height / 2;
  expect(
    Math.abs(lupeCenter - titleCenter),
    'Lupe und Titelzeile teilen keine Zeile',
  ).toBeLessThanOrEqual(4);
});

test('AK3: der Woche/Alle/Erledigt-Umschalter steht innerhalb von .page-head, nicht als eigene Zeile darunter', async ({
  page,
}) => {
  await registerPasskey(page, '/aufgaben');
  await seedTask(page, { title: 'AK3 Aufgabe', dueAt: null });
  await page.reload();

  // Strict-Mode-Locator: schlägt fehl, gäbe es (wie vor #1117) eine zweite
  // Instanz außerhalb von .page-head.
  const switcherInHead = page.locator('.page-head .task-list__view-switcher');
  await expect(switcherInHead).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Aufgaben-Ansicht' })).toBeVisible();
});

test('AK6: bei 1280px und 375px bleibt der Kopf gestapelt, der Umschalter unter der Kopfzeile', async ({
  page,
}) => {
  await registerPasskey(page, '/aufgaben');
  await seedTask(page, { title: 'AK6 Aufgabe', dueAt: null });
  await page.reload();

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);

    const display = await page.locator('.page-head').first().evaluate((el) => getComputedStyle(el).display);
    expect(display, `${viewport.width}px: .page-head ist bereits eine Flex-Zeile`).not.toBe('flex');

    const eyebrowBox = await page.locator("[data-ground='aufgaben'] .page-head__eyebrow").boundingBox();
    const switcherBox = await page.locator('.task-list__view-switcher').boundingBox();
    expect(eyebrowBox, `${viewport.width}px: Augenbraue`).not.toBeNull();
    expect(switcherBox, `${viewport.width}px: Umschalter`).not.toBeNull();
    expect(
      switcherBox!.y,
      `${viewport.width}px: Umschalter steht nicht unter der Augenbraue`,
    ).toBeGreaterThan(eyebrowBox!.y + eyebrowBox!.height);
  }
});
