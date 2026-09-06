import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetDatabase } from './helpers';

/**
 * Shell assertions that only hold in the mobile layout.
 *
 * Playwright routes this file to the `mobile` project alone (playwright.config.ts),
 * which is the framework's own mechanism for viewport-scoped specs. The alternative —
 * keeping one shared file and bailing out at runtime when the project name does not
 * match — is a runtime skip, and `test-integrity` rejects those on sight: it cannot
 * tell a scoped test apart from a disabled one, and that bluntness is the point
 * (CLAUDE.md Regel 5).
 *
 * The desktop counterparts live in shell.desktop.spec.ts. Anything true in *both*
 * layouts belongs in shell.spec.ts, which keeps running in both projects.
 */

// Drives the auth UI itself and asserts the never-registered state, so it opts out of
// the shared owner session and keeps the full reset (#115).
test.use({ storageState: { cookies: [], origins: [] } });

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  // issue #230/memory: /aktivitaeten stößt beim Öffnen /api/garmin-sync an, ungemockt
  // 503 landet als Dev-Overlay-Badge im DOM. /uebersicht holt Wetter — ungemockt
  // leckt der echte Fetch in jeden Test, der diese Route besucht (beide unten besucht).
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
});

/** Mirrors grundfarbe.spec.ts's own probe-span technique (issue #846). */
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

/**
 * getComputedStyle can serialize an oklch()-declared colour back as oklch() rather than
 * rgb() — a 1×1 canvas sidesteps that, see grundfarbe.spec.ts.
 */
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

async function metaThemeColor(page: Page, media: string): Promise<string | null> {
  return page.evaluate(
    (m) => document.querySelector(`meta[name="theme-color"][media="${m}"]`)?.getAttribute('content') ?? null,
    media,
  );
}

/** The top-level (not the ≥768px media-query override) authored rule, not the resolved style. */
async function authoredShellMainPaddingTop(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && rule.selectorText === '.shell__main') {
          return rule.style.paddingTop;
        }
      }
    }
    return '';
  });
}

const WHITE: [number, number, number] = [255, 255, 255];

// The eight authenticated ground routes (issue #882) — same ground token names as
// grundfarbe.spec.ts's ROUTES. Anmelden needs a logged-out context and is covered
// separately as the ninth.
const GROUND_ROUTES: { ground: string; path: string }[] = [
  { ground: 'uebersicht', path: '/uebersicht' },
  { ground: 'aufgaben', path: '/aufgaben' },
  { ground: 'kalender', path: '/kalender' },
  { ground: 'routinen', path: '/routinen' },
  { ground: 'journal', path: '/journal' },
  { ground: 'aktivitaeten', path: '/aktivitaeten' },
  { ground: 'wetter', path: '/wetter/2026-07-18' },
  { ground: 'einstellungen', path: '/einstellungen' },
];

test('the settings entry point sits inline on Übersicht and on none of the other four screens (issue #126 AC1+AC2)', async ({
  page,
}) => {
  await registerPasskey(page);

  const uebersichtSettings = page.getByRole('link', { name: 'Einstellungen' });
  await expect(uebersichtSettings).toBeVisible();

  for (const path of ['/aufgaben', '/routinen', '/kalender', '/journal']) {
    await page.goto(path);
    await expect(page.getByRole('link', { name: 'Einstellungen' })).toHaveCount(0);
  }
});

test('/uebersicht rückt näher an die Statusleiste heran, ohne unter sie zu rutschen (issue #137 AC3+AC4)', async ({
  page,
}) => {
  await registerPasskey(page, '/uebersicht');

  const main = page.locator('main.shell__main');
  const paddingTop = await main.evaluate((el) => getComputedStyle(el).paddingTop);
  // var(--space-4) + env(safe-area-inset-top); the test browser has no notch, so the
  // inset resolves to 0 and the computed value is the bare token.
  expect(paddingTop).toBe('16px');
});

test('das Einstellungen-Symbol auf /uebersicht steht auf einer Linie mit dem Datum, rechtsbündig, mit vollem Touch-Ziel (issue #137 AC5, seit #920 in der Augenbraue statt der Titelzeile)', async ({
  page,
}) => {
  await registerPasskey(page, '/uebersicht');

  // issue #920 AK3: Ring und Einstellungs-Einstieg zogen aus der Titelzeile in
  // die Augenbraue, auf eine Linie mit dem Datum — die Überschrift (Begrüßung)
  // ist seither allein in der Titelzeile, ohne die Aktionen daneben.
  const eyebrowDate = page.locator('[data-ground="uebersicht"] .uebersicht__eyebrow-date');
  const settings = page.getByRole('link', { name: 'Einstellungen' });
  const main = page.locator('main.shell__main');
  const [eyebrowDateBox, settingsBox, mainBox, mainPaddingRight] = await Promise.all([
    eyebrowDate.boundingBox(),
    settings.boundingBox(),
    main.boundingBox(),
    main.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight)),
  ]);
  expect(eyebrowDateBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  const dateCenter = eyebrowDateBox!.y + eyebrowDateBox!.height / 2;
  const settingsCenter = settingsBox!.y + settingsBox!.height / 2;
  expect(Math.abs(dateCenter - settingsCenter)).toBeLessThan(2);

  // main's own box includes its padding, so the content column's right edge —
  // where "right-aligned" content actually sits — is inset by padding-right.
  const contentRightEdge = mainBox!.x + mainBox!.width - mainPaddingRight;
  expect(Math.abs(settingsBox!.x + settingsBox!.width - contentRightEdge)).toBeLessThan(2);
  expect(settingsBox!.width).toBeGreaterThanOrEqual(44);
  expect(settingsBox!.height).toBeGreaterThanOrEqual(44);
});

/**
 * AK2/AK3, ein Theme: registerPasskey + 8 Routen + /offline in einem einzigen
 * 30s-Testfenster überschritt das Zeitbudget knapp, wenn beide Themes in einem
 * Test liefen (issue #882 CI-Fund) — deshalb zwei Tests statt einem, wie
 * grundfarbe.spec.ts es für seine hell/dunkel-Kontrastchecks bereits macht.
 */
async function assertGroundNotchContrast(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });

  for (const route of GROUND_ROUTES) {
    await page.goto(route.path);
    const notch = await resolveColorToken(page, '--ground-notch');
    expect(
      contrastRatio(await toRgb(page, notch), WHITE),
      `--ground-notch auf ${route.path} (${scheme})`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  // AK3: eine Route ohne data-ground hängt am :root-Fallback, nicht an einer
  // der neun Grundfarben.
  await page.goto('/offline');
  const offlineNotch = await resolveColorToken(page, '--ground-notch');
  expect(
    contrastRatio(await toRgb(page, offlineNotch), WHITE),
    `--ground-notch auf /offline (${scheme})`,
  ).toBeGreaterThanOrEqual(4.5);
}

test('AK2/AK3 hell: --ground-notch erfüllt 4,5:1 gegen Weiß auf allen acht Routen und dem /offline-Fallback (issue #882)', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertGroundNotchContrast(page, 'light');
});

test('AK2/AK3 dunkel: --ground-notch erfüllt 4,5:1 gegen Weiß auf allen acht Routen und dem /offline-Fallback (issue #882)', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertGroundNotchContrast(page, 'dark');
});

test('AK2: --ground-notch auf /anmelden (ausgeloggt, neunte Route) erfüllt 4,5:1 gegen Weiß, hell und dunkel (issue #882)', async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/anmelden');
    const notch = await resolveColorToken(page, '--ground-notch');
    expect(
      contrastRatio(await toRgb(page, notch), WHITE),
      `--ground-notch auf /anmelden (${scheme})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

/**
 * ±3 je Kanal: oklch-Token vs. authored Hex runden über den Canvas-Umweg (toRgb)
 * minimal unterschiedlich, exakte Gleichheit ist nicht das Ziel. Gemessener
 * Extremfall ist Aktivitäten (oklch(80.9% 0.17 75.4) vs. #ffae00): Blaukanal
 * weicht um genau 3 ab, jede andere Route bleibt bei ≤1.
 */
async function assertThemeColorMatchesGround(page: Page, ground: string, routeLabel: string) {
  const content = await metaThemeColor(page, '(prefers-color-scheme: light)');
  expect(content, `theme-color auf ${routeLabel}`).not.toBeNull();

  const groundToken = await resolveColorToken(page, `--ground-${ground}`);
  const [groundRgb, metaRgb] = await Promise.all([toRgb(page, groundToken), toRgb(page, content!)]);
  for (let channel = 0; channel < 3; channel += 1) {
    expect(
      Math.abs(groundRgb[channel] - metaRgb[channel]),
      `theme-color-Kanal ${channel} auf ${routeLabel}`,
    ).toBeLessThanOrEqual(3);
  }
}

test('AK4: jede der acht Routen gibt ihre Grundfarbe als theme-color für Android aus (issue #882)', async ({
  page,
}) => {
  await registerPasskey(page);

  for (const route of GROUND_ROUTES) {
    await page.goto(route.path);
    await assertThemeColorMatchesGround(page, route.ground, route.path);
  }
});

test('AK4: /anmelden (ausgeloggt, neunte Route) gibt seine Grundfarbe als theme-color aus (issue #882)', async ({
  page,
}) => {
  await page.goto('/anmelden');
  await assertThemeColorMatchesGround(page, 'anmelden', '/anmelden');
});

test('AK5: die authored Regel für .shell__main führt env(safe-area-inset-top) in ihrer padding-top-Rechnung (issue #882)', async ({
  page,
}) => {
  await registerPasskey(page, '/uebersicht');
  const paddingTop = await authoredShellMainPaddingTop(page);
  expect(paddingTop).toContain('env(safe-area-inset-top)');
});

/**
 * AK3 (issue #982) selbst — dass das Token aus tokens.css entfernt ist und
 * nirgends mehr referenziert wird — ist ein `git grep`-Befund, kein
 * Laufzeitverhalten: einmal aus tokens.css entfernt, kann kein Test im
 * Browser mehr etwas über ein nicht mehr existierendes Custom Property
 * aussagen, ohne die entfernte Zeichenkette selbst wieder in diese Datei zu
 * schreiben. Die drei Tests unten prüfen deshalb, was tatsächlich beobachtbar
 * ist: AK1, dass `.bg-layer__veil` als Element nirgends mehr im DOM steht —
 * in beiden Farbschemata, falls eine `@media`-Regel es versehentlich nur in
 * einem der beiden zurückbrächte.
 */
async function assertNoVeilElement(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme });

  for (const route of GROUND_ROUTES) {
    await page.goto(route.path);
    await expect(page.locator('.bg-layer__veil')).toHaveCount(0);
  }

  // eine Route ohne data-ground hängt am --ground-Fallback, nicht an einer
  // der neun Grundfarben — derselbe Fallback, den AK2/AK3 (issue #882) oben
  // schon für --ground-notch mitprüfen.
  await page.goto('/offline');
  await expect(page.locator('.bg-layer__veil')).toHaveCount(0);
}

test('AK1 (#982) hell: kein Schleier-Element mehr im DOM, auf allen acht Routen und dem /offline-Fallback', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertNoVeilElement(page, 'light');
});

test('AK1 (#982) dunkel: kein Schleier-Element mehr im DOM, auf allen acht Routen und dem /offline-Fallback', async ({
  page,
}) => {
  await registerPasskey(page);
  await assertNoVeilElement(page, 'dark');
});

test('AK1 (#982): kein Schleier-Element mehr im DOM auf /anmelden (ausgeloggt, neunte Route), hell und dunkel', async ({
  page,
}) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/anmelden');
    await expect(page.locator('.bg-layer__veil')).toHaveCount(0);
  }
});
