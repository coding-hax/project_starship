import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * Kartenrhythmus der Aufgabenliste (issue #866, T2 von #860). #866s "eine
 * Gruppe ist eine Karte" ist seit issue #996 umgekehrt: eine gemeinsame
 * Fläche (`.task-list__surface`, `--radius-surface`, `--shadow-raised`)
 * trägt jetzt die ganze Liste, Bucket-Gruppen sind nur noch durch Weißraum
 * und ihren Kopf getrennt (task-list.css's Datei-Banner,
 * docs/design/formwahl-und-zustaende.md R1) — vorher war das eine flache
 * Zeile mit Hairline (issue #704), dann eine Karte je Gruppe (issue #866),
 * jetzt eine gemeinsame Karte für alles (issue #996). Die "7 Tage"-Ansicht
 * bündelt weiterhin in drei feste Buckets — "Überfällig" / "Heute" /
 * "7 Tage" — statt einer Marke je Tag (Variante A, unverändert). Regressionen
 * (Drag-to-Nest, Presence, …) bleiben tasks.spec.ts/uebersicht.spec.ts — hier
 * nur, was an der (jetzt gemeinsamen) Fläche selbst neu ist.
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // The list must come from IndexedDB, never a direct fetch (CLAUDE.md rule 8).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  // /uebersicht fetches weather and pokes Garmin sync on load (see
  // grundfarbe-vollfarbe.spec.ts's own beforeEach) — mocked so the AK-Ü tests
  // below can visit it without leaking a real network call.
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: {
        daily: {
          time: ['2026-07-18'],
          weather_code: [0],
          temperature_2m_max: [20],
          temperature_2m_min: [10],
          precipitation_probability_max: [0],
          sunrise: ['2026-07-18T05:00'],
          sunset: ['2026-07-18T21:00'],
          wind_speed_10m_max: [10],
          wind_gusts_10m_max: [15],
        },
        hourly: {
          time: Array.from({ length: 24 }, (_, h) => `2026-07-18T${String(h).padStart(2, '0')}:00`),
          temperature_2m: Array.from({ length: 24 }, () => 15),
          precipitation_probability: Array.from({ length: 24 }, () => 0),
          precipitation: Array.from({ length: 24 }, () => 0),
        },
      },
    }),
  );
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
});

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** `FIXED_NOW` shifted by whole local-calendar days, at a fixed local clock
 *  time — mirrors tasks.spec.ts's own helper of the same name. */
function isoAt(daysFromNow: number, hours = 9): string {
  const date = new Date(FIXED_NOW);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
}

/** Scoped to the task list — a page-wide listitem query also matches the nav tabs. */
function taskItems(page: Page) {
  return page.getByRole('list', { name: 'Aufgaben' }).getByRole('listitem');
}

/** The one shared card for the whole list (issue #996 AK1) — carries the
 *  `--surface`/`--radius-surface`/`--shadow-raised`/ink-reset styling that
 *  used to sit on every `.task-list__group-card` individually (issue #866). */
function surface(page: Page) {
  return page.locator('.task-list__surface');
}

/** A bucket group's own wrapper (issue #866) — no longer a card of its own
 *  since issue #996: just the `<li role="presentation">` holding a header and
 *  its rows, reading as a section of `surface()` via whitespace alone. */
function groups(page: Page) {
  return page.locator('.task-list__group');
}

function groupTitles(page: Page) {
  return page.locator('.task-list__group-title');
}

/** Mirrors grundfarbe.spec.ts's/grundfarbe-vollfarbe.spec.ts's own probe-span technique. */
async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/** Same idea, for `border-radius`/`box-shadow`/`padding` — resolves a token to
 *  its computed value without hardcoding the px/shadow literal in the assertion. */
async function resolveToken(page: Page, property: string, token: string): Promise<string> {
  return page.evaluate(
    ({ property, token }) => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, `var(${token})`);
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { property, token },
  );
}

/** Same probe technique as `resolveColorToken`, but the probe is a child of
 *  `selector` — resolves the custom property from that element's own cascade
 *  context (mirrors grundfarbe-vollfarbe.spec.ts's `resolveColorTokenIn`, issue #831). */
async function resolveColorTokenIn(page: Page, selector: string, token: string): Promise<string> {
  return page.evaluate(
    ({ selector, token }) => {
      const container = document.querySelector(selector)!;
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      container.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    },
    { selector, token },
  );
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio (1–21) between two 0–255 sRGB byte tuples. */
function contrastRatio(rgbA: [number, number, number], rgbB: [number, number, number]): number {
  const [la, lb] = [relativeLuminance(...rgbA), relativeLuminance(...rgbB)];
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** See grundfarbe.spec.ts's own `toRgb` for why canvas, not a regex on rgb()/oklch(). */
async function toRgb(page: Page, color: string): Promise<[number, number, number]> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, color);
}

test('AK1: eine gemeinsame Fläche trägt die ganze Liste — Fläche, Radius, Schatten, Polsterung; Gruppen und Zeilen darin tragen keine eigene Fläche', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig-Sonde', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'Heute-Sonde', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'Woche-Sonde', dueAt: isoAt(2) });

  // Genau eine Fläche für die ganze Liste (AK1) — nicht mehr eine je Gruppe.
  await expect(surface(page)).toHaveCount(1);
  await expect(groups(page)).toHaveCount(3);

  const surfaceToken = await resolveColorToken(page, '--surface');
  const radiusToken = await resolveToken(page, 'border-radius', '--radius-surface');
  const shadowToken = await resolveToken(page, 'box-shadow', '--shadow-raised');
  // Longhand, not the `padding` shorthand — `getComputedStyle` only normalizes
  // that reliably back to a string for longhands like `padding-top`.
  const paddingToken = await resolveToken(page, 'padding-top', '--space-4');

  const card = surface(page);
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(surfaceToken);
  expect(await card.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(radiusToken);
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(shadowToken);
  expect(await card.evaluate((el) => getComputedStyle(el).paddingTop)).toBe(paddingToken);

  // Die Gruppen selbst tragen weder Fläche noch Radius noch Schatten — nur die
  // gemeinsame Karte (AK1; AK4: "nur durch Abstand und ihren Kopf getrennt").
  const group = groups(page).first();
  expect(await group.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(await group.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  expect(await group.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');

  // Die Zeile selbst trägt ebenfalls weder Radius noch Schatten — nur die Karte.
  const row = taskItems(page).first();
  expect(await row.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');

  // Abstand zwischen zwei Gruppen = --space-3 (AK4) — die einzige Trennung
  // zwischen ihnen, keine Haarlinie.
  const gapToken = await resolveToken(page, 'margin-top', '--space-3');
  const gapPx = parseFloat(gapToken);
  const firstBox = await groups(page).nth(0).boundingBox();
  const secondBox = await groups(page).nth(1).boundingBox();
  if (!firstBox || !secondBox) throw new Error('missing bounding box');
  expect(Math.abs(secondBox.y - (firstBox.y + firstBox.height) - gapPx)).toBeLessThan(1);
});

test('AK1: mehrere an verschiedenen Wochentagen fällige Aufgaben landen in einer "7 Tage"-Gruppe, Anzahl rechts = Top-Level-Zeilen', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  const parentId = await seedTask(page, { title: 'Übermorgen-Eltern', dueAt: isoAt(2) });
  await seedTask(page, { title: 'Übermorgen-Kind', parentId });
  await seedTask(page, { title: 'In 5 Tagen', dueAt: isoAt(5) });

  await expect(groupTitles(page)).toHaveCount(1);
  await expect(groupTitles(page).first()).toHaveText('7 Tage');

  // Anzahl = Top-Level-Zeilen (2), nicht inklusive der Unteraufgabe.
  const count = page.locator('.task-list__group-count').first();
  await expect(count).toHaveText('2');
});

test('AK2: die dritte Bucket-Gruppe heißt „7 Tage" statt „Diese Woche" (issue #979)', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig-Sonde', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'Heute-Sonde', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'In 3 Tagen', dueAt: isoAt(3) });

  const titles = groupTitles(page);
  await expect(titles).toHaveCount(3);
  await expect(titles.nth(2)).toHaveText('7 Tage');
});

test('AK2/AK8 (issue #866/#996): eine leer werdende Gruppe verschwindet als eigene Einheit, die übrigen Gruppen und die Fläche selbst bleiben unberührt', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Überfällig bleibt', dueAt: isoAt(-1) });
  const todayId = await seedTask(page, { title: 'Heute-Sonde', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'Woche bleibt', dueAt: isoAt(2) });

  await expect(groupTitles(page)).toHaveCount(3);
  const surfaceTopBefore = (await surface(page).boundingBox())?.y;
  if (surfaceTopBefore === undefined) throw new Error('missing bounding box');

  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'tasks', rowId, op: 'delete' }),
    todayId,
  );

  await expect(groupTitles(page)).toHaveCount(2);
  await expect(groupTitles(page).nth(0)).toHaveText('Überfällig');
  await expect(groupTitles(page).nth(1)).toHaveText('7 Tage');

  // Die Fläche selbst springt nicht (AK8) — ihr oberer Rand bleibt an
  // derselben Stelle, während nur die mittlere Gruppe verschwindet.
  const surfaceTopAfter = (await surface(page).boundingBox())?.y;
  if (surfaceTopAfter === undefined) throw new Error('missing bounding box');
  expect(Math.abs(surfaceTopAfter - surfaceTopBefore)).toBeLessThan(1);
});

test('AK9 (Locator-Erhalt, issue #996 / vormals AK2 issue #866): die Zeile bleibt unter der einen "Aufgaben"-Liste erreichbar, die Gruppe selbst zählt nicht als listitem', async ({
  page,
}) => {
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Locator-Sonde', dueAt: FIXED_NOW });

  const list = page.getByRole('list', { name: 'Aufgaben' });
  await expect(list.getByRole('listitem')).toHaveCount(1);

  const group = groups(page).first();
  await expect(group).toHaveAttribute('role', 'presentation');
  await expect(group.getByRole('listitem')).toHaveCount(1);

  const row = list.getByRole('listitem').first();
  expect(await row.evaluate((el) => el.closest('.task-list__group') !== null)).toBe(true);
});

/**
 * "Kopf" in AK-Ü meint den Seitenkopf, nicht das Dokument (issue #865s eigene
 * AK8: "scrollHeight <= clientHeight für den Kopfbereich"; dasselbe Muster wie
 * `assertHeaderFitsItself` in seitenkopf.spec.ts). /uebersicht ist eine volle
 * Dashboard-Seite (Wetter, Kalender, Aufgaben, Aktivitäten, Routinen) und
 * scrollt legitim über 812px hinaus (siehe scroll-position.spec.ts) — nur der
 * `.page-head` selbst darf nicht über sich selbst laufen, unabhängig davon,
 * wie hoch die Aufgabenliste darunter wird.
 */
async function assertHeaderFitsItself(page: Page, path: string, scheme: string) {
  const header = page.locator('.page-head');
  await expect(header).toBeVisible();
  const { scrollHeight, clientHeight } = await header.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    scrollHeight,
    `${path} (${scheme}): Kopf läuft nicht über sich selbst`,
  ).toBeLessThanOrEqual(clientHeight);
}

test('AK-Ü: der Seitenkopf läuft auf /aufgaben und /uebersicht nicht über sich selbst, kein horizontaler Überlauf, Hell und Dunkel', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'AK-Ü Überfällig', dueAt: isoAt(-1) });
  await seedTask(page, { title: 'AK-Ü Heute', dueAt: isoAt(0, 9) });
  await seedTask(page, { title: 'AK-Ü Woche', dueAt: isoAt(2) });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/aufgaben', '/uebersicht']) {
      await page.goto(path);
      await expect(surface(page)).toBeVisible();
      await assertHeaderFitsItself(page, path, scheme);

      const overflowWidth = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflowWidth.scrollWidth,
        `${path} (${scheme}): kein horizontaler Überlauf`,
      ).toBeLessThanOrEqual(overflowWidth.clientWidth);
    }
  }
});

test('AK6 (issue #996 / vormals AK-Ü issue #866): die gemeinsame Fläche setzt ihren Ink zurück — Zeilentext ≠ Kartengrund, Kontrast ≥ 4,5:1, Hell und Dunkel', async ({
  page,
}) => {
  await installClockAt(page, FIXED_NOW);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/aufgaben');
    await seedTask(page, { title: `Ink-Sonde ${scheme}`, dueAt: isoAt(0, 9) });
    await expect(surface(page)).toBeVisible();

    const textBase = await resolveColorToken(page, '--text-base');
    const cardText = await resolveColorTokenIn(page, '.task-list__surface', '--text');
    expect(cardText, `.task-list__surface löst --text auf --text-base auf (${scheme})`).toBe(
      textBase,
    );

    const card = surface(page);
    const cardBackground = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    const rowTitle = page.getByText(`Ink-Sonde ${scheme}`);
    const rowColor = await rowTitle.evaluate((el) => getComputedStyle(el).color);
    expect(rowColor, `Zeilentext ≠ Kartengrund (${scheme})`).not.toBe(cardBackground);
    expect(
      contrastRatio(await toRgb(page, rowColor), await toRgb(page, cardBackground)),
      `Kontrast Zeilentext/Kartenfläche (${scheme})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('Offline-Pfad: eine offline angelegte Aufgabe erscheint sofort in der gemeinsamen Kartenfläche, erreicht online die Datenbank', async ({
  page,
  context,
}) => {
  await installClockAt(page, FIXED_NOW);
  await page.goto('/aufgaben');
  await context.setOffline(true);

  await seedTask(page, { title: 'Offline Kartensonde', dueAt: isoAt(0, 9) });

  await expect(groupTitles(page).filter({ hasText: 'Heute' })).toBeVisible();
  const row = taskItems(page).filter({ hasText: 'Offline Kartensonde' });
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => el.closest('.task-list__surface') !== null)).toBe(true);

  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', ['Offline Kartensonde']),
  );
  expect(rows.rows.map((r) => r.title)).toEqual(['Offline Kartensonde']);
});
