import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Vollfarb-Seitengrund je Route (issue #832, S1 von #828). Ein Test je AK; jeder
 * Test misst Kontrast per getComputedStyle statt per Augenschein (Ticket-Vorgabe).
 */

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // issue #230/memory: /aktivitaeten stößt beim Öffnen /api/garmin-sync an, ungemockt
  // 503 landet als Dev-Overlay-Badge im DOM. /uebersicht holt Wetter — ungemockt
  // leckt der echte Fetch in jeden Test, der diese Route besucht.
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

/** Mirrors habits-uebersicht.spec.ts's own probe-span technique. */
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
 * getComputedStyle can serialize an oklch()-declared colour back as oklch()
 * rather than rgb() (CSS Color 4) — a regex expecting "rgb(r, g, b)" would
 * silently misparse the L/C/H numbers as R/G/B. A 1×1 canvas sidesteps that:
 * its 2D context is always sRGB, so reading the pixel back after setting
 * fillStyle gives real 0–255 channels regardless of the source syntax (same
 * technique as design-system.spec.ts, issue #709).
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

async function elementColor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

async function htmlBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

async function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

async function seedHabit(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'habits', op: 'upsert', payload: p }),
    payload,
  );
}

interface RouteCase {
  /** Matches the `--ground-<ground>` token and the `data-ground` attribute value. */
  ground: string;
  path: string;
  /** Which fixed-ink token this route's --on-ground resolves to in light mode. */
  ink: '--on-accent' | '--on-ground-light';
  heading: (page: Page) => Locator;
}

// The eight authenticated routes — Anmelden needs a logged-out context and gets its
// own describe block below, sharing this same table's shape.
const ROUTES: RouteCase[] = [
  {
    ground: 'uebersicht',
    path: '/uebersicht',
    ink: '--on-accent',
    // Kein Name-Filter (issue #862): der Titel ist eine tageszeitabhängige Begrüßung.
    heading: (page) => page.locator('[data-ground="uebersicht"] h1'),
  },
  {
    ground: 'aufgaben',
    path: '/aufgaben',
    ink: '--on-ground-light',
    heading: (page) => page.getByRole('heading', { level: 1, name: 'Aufgaben' }),
  },
  {
    ground: 'kalender',
    path: '/kalender',
    ink: '--on-ground-light',
    // .calendar-view__heading (h1) is visually hidden (sr-only) — the visible,
    // flächenlos "Monat Jahr" title is what a person actually reads on the ground.
    heading: (page) => page.locator('.calendar-strip__title'),
  },
  {
    ground: 'routinen',
    path: '/routinen',
    ink: '--on-accent',
    heading: (page) => page.getByRole('heading', { level: 1, name: 'Routinen verwalten' }),
  },
  {
    ground: 'journal',
    path: '/journal',
    ink: '--on-ground-light',
    heading: (page) => page.getByRole('heading', { level: 1, name: 'Journal' }),
  },
  {
    ground: 'aktivitaeten',
    path: '/aktivitaeten',
    ink: '--on-accent',
    heading: (page) => page.getByRole('heading', { level: 1, name: 'Aktivitäten' }),
  },
  {
    ground: 'wetter',
    path: '/wetter/2026-07-18',
    ink: '--on-accent',
    // No cached forecast is seeded (offline-agnostic AC "kein eigener Netzaufruf")
    // — the day-detail topbar with its date heading renders in every phase.
    heading: (page) => page.locator('.weather-day__date'),
  },
  {
    ground: 'einstellungen',
    path: '/einstellungen',
    ink: '--on-ground-light',
    heading: (page) => page.getByRole('heading', { level: 1, name: 'Einstellungen' }),
  },
];

test('AK1: jede der neun Routen rendert ihren Seitengrund vollflächig', async ({ page }) => {
  await registerPasskey(page);

  const bgToken = await resolveColorToken(page, '--bg');

  for (const route of ROUTES) {
    await page.goto(route.path);
    const groundToken = await resolveColorToken(page, `--ground-${route.ground}`);

    expect(await htmlBackground(page), `html-Hintergrund auf ${route.path}`).toBe(groundToken);
    expect(await bodyBackground(page), `body-Hintergrund auf ${route.path}`).toBe(groundToken);
    // Kein cremefarbener Rest: der Grund ist nie einfach der generische --bg-Fallback.
    expect(groundToken, `--ground-${route.ground} weicht von --bg ab`).not.toBe(bgToken);
  }
});

test('AK2: Text auf dem Grund erfüllt 4,5:1, Gold trägt dunkle Tinte statt Weiß', async ({
  page,
}) => {
  await registerPasskey(page);
  // dueAt gesetzt: ohne Fälligkeit landet der Task in der eingeklappten "ohne
  // Datum"-SectionCard (task-list.tsx) statt flächenlos in der Hauptliste —
  // Playwright hält ihren Titel trotz grid-template-rows:0fr für "visible"
  // (Bounding-Box/visibility geprüft, kein Ancestor-Clipping), die Karte setzt
  // --text laut AK5 aber korrekt auf die neutrale Kartentinte zurück. Ohne
  // dueAt misst dieser Block also Kartentinte gegen Seitengrund statt des
  // beabsichtigten flächenlosen Listentexts.
  await seedTask(page, { title: 'Grundfarbe Kontrast-Sonde', dueAt: FIXED_NOW });

  for (const route of ROUTES) {
    await page.goto(route.path);
    const ground = await htmlBackground(page);
    const inkToken = await resolveColorToken(page, route.ink);
    const heading = route.heading(page);
    await expect(heading).toBeVisible();

    const headingColor = await elementColor(heading);
    expect(headingColor, `Tinte auf ${route.path} kommt aus ${route.ink}`).toBe(inkToken);
    expect(
      contrastRatio(await toRgb(page, headingColor), await toRgb(page, ground)),
      `Kontrast Titel/Grund auf ${route.path}`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  // AK2 explizit: Gold (Aktivitäten) trägt --on-accent, nicht Weiß.
  await page.goto('/aktivitaeten');
  const onAccent = await resolveColorToken(page, '--on-accent');
  const onGroundLight = await resolveColorToken(page, '--on-ground-light');
  const heading = page.getByRole('heading', { level: 1, name: 'Aktivitäten' });
  expect(await elementColor(heading)).toBe(onAccent);
  expect(await elementColor(heading)).not.toBe(onGroundLight);

  // Ein flächenloser Listentext (nicht nur die Titelzeile) erfüllt 4,5:1 ebenso.
  await page.goto('/aufgaben');
  const taskGround = await htmlBackground(page);
  const taskTitle = page.getByText('Grundfarbe Kontrast-Sonde');
  await expect(taskTitle).toBeVisible();
  expect(
    contrastRatio(await toRgb(page, await elementColor(taskTitle)), await toRgb(page, taskGround)),
  ).toBeGreaterThanOrEqual(4.5);
});

test('AK3: bereichsgefüllte Flächen tragen weiter --on-accent, unverändert seit #709', async ({
  page,
}) => {
  // issue #831 AK3 kehrt die FAB bewusst um (hell auf dem Grund, Glyph in
  // abgedunkelter Bereichsfarbe) — dieser Test war bis #831 die FAB-Sonde für
  // die #709-Invariante "Text auf einer bereichsgefüllten Fläche = --on-accent"
  // und wandert jetzt auf einen weiterhin bereichsgefüllten Knopf: den
  // Speichern-Knopf im Task-Editor (task-editor.css:75-76, unverändert von #831).
  await registerPasskey(page);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Kontrast-Sonde Speichern', dueAt: FIXED_NOW });

  const onAccent = await resolveColorToken(page, '--on-accent');
  await page
    .getByRole('list', { name: 'Aufgaben' })
    .getByRole('listitem')
    .filter({ hasText: 'Kontrast-Sonde Speichern' })
    .click();
  const submit = page.getByRole('button', { name: 'Speichern' });
  await expect(submit).toBeVisible();
  expect(await elementColor(submit)).toBe(onAccent);
});

test('AK4: im Dunkelmodus ist der Grund abgedunkelt, Weiß bleibt ≥4,5:1', async ({ page }) => {
  await registerPasskey(page);
  await page.emulateMedia({ colorScheme: 'dark' });

  const onGroundLight = await resolveColorToken(page, '--on-ground-light');

  for (const route of ROUTES) {
    await page.goto(route.path);
    const darkGround = await htmlBackground(page);
    const lightGroundToken = await resolveColorToken(page, `--ground-${route.ground}`);

    // Abgedunkelt: nie die reine (helle) Seitenfarbe bei voller Sättigung.
    expect(darkGround, `Grund auf ${route.path} ist im Dark Mode gemischt`).not.toBe(
      lightGroundToken,
    );

    const heading = route.heading(page);
    await expect(heading).toBeVisible();
    const headingColor = await elementColor(heading);
    expect(headingColor, `Dark-Mode-Tinte auf ${route.path} ist --on-ground-light`).toBe(
      onGroundLight,
    );
    expect(
      contrastRatio(await toRgb(page, headingColor), await toRgb(page, darkGround)),
      `Dark-Mode-Kontrast auf ${route.path}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('AK5: Karten setzen den Textkontext zurück, dieselbe Klasse liegt auf Grund und Karte richtig', async ({
  page,
}) => {
  await registerPasskey(page);
  await seedHabit(page, { name: 'Kontext-Sonde', schedule: 'daily', color: null, archivedAt: null });
  await page.goto('/routinen');

  const onAccent = await resolveColorToken(page, '--on-accent');
  const textBase = await resolveColorToken(page, '--text-base');

  // Flächenlos direkt auf dem (dunkel-getönten) Grund: erbt die helle/dunkle
  // Kontext-Tinte des Grunds (hier --on-accent, Routinen ist ein heller Grund).
  const heading = page.getByRole('heading', { level: 1, name: 'Routinen verwalten' });
  expect(await elementColor(heading)).toBe(onAccent);

  // Dieselbe Rolle auf einer Karte (.habit-list__item, eigene --surface) liegt
  // stattdessen auf der fixen neutralen Tinte, nicht auf der Grund-Tinte.
  const cardTitle = page.locator('.habit-list__title', { hasText: 'Kontext-Sonde' });
  await expect(cardTitle).toBeVisible();
  expect(await elementColor(cardTitle)).toBe(textBase);
  expect(await elementColor(cardTitle)).not.toBe(onAccent);

  // Die Leiste (.nav, eigene --surface) trägt ihre eigene Tinte, nicht die des Grunds.
  const navLink = page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', {
    name: 'Aufgaben',
  });
  const navColor = await elementColor(navLink);
  expect(navColor).not.toBe(onAccent);
});

test.describe('#846: Kanten auf dem Grund erfüllen 3:1 (WCAG 1.4.11)', () => {
  test('AK3/AK5 hell: --border und --border-strong erfüllen 3:1 gegen den Grund auf allen acht Routen', async ({
    page,
  }) => {
    await registerPasskey(page);

    for (const route of ROUTES) {
      await page.goto(route.path);
      const ground = await htmlBackground(page);
      const border = await resolveColorToken(page, '--border');
      const borderStrong = await resolveColorToken(page, '--border-strong');
      expect(
        contrastRatio(await toRgb(page, border), await toRgb(page, ground)),
        `--border auf ${route.path}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(await toRgb(page, borderStrong), await toRgb(page, ground)),
        `--border-strong auf ${route.path}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test('AK3/AK5 dunkel: --border und --border-strong erfüllen 3:1 gegen den Grund auf allen acht Routen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: 'dark' });

    for (const route of ROUTES) {
      await page.goto(route.path);
      const ground = await htmlBackground(page);
      const border = await resolveColorToken(page, '--border');
      const borderStrong = await resolveColorToken(page, '--border-strong');
      expect(
        contrastRatio(await toRgb(page, border), await toRgb(page, ground)),
        `--border auf ${route.path} (dunkel)`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(await toRgb(page, borderStrong), await toRgb(page, ground)),
        `--border-strong auf ${route.path} (dunkel)`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test('AK1: Stimmungsband-Grundlinie (kein Mood) erfüllt 3:1 gegen den Journal-Grund im Dunkelmodus. Heute 1,02:1', async ({
    page,
  }) => {
    await registerPasskey(page);
    await installClockAt(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/journal');

    const passphrase = '846 kontrast passphrase';
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await page.getByLabel('Passphrase wiederholen').fill(passphrase);
    await page.getByRole('button', { name: 'Einrichten' }).click();
    await page.getByTestId('journal-recovery-key').waitFor();
    await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
    await page.locator('.journal-gate[data-state="unlocked"]').waitFor();

    // Ein reiner Text-Eintrag ohne Stimmung -> die anderen 13 Tagesplätze zeigen
    // die graue Grundlinie (journal.spec.ts's "wenige Einträge"-Fall).
    await page.evaluate(() =>
      window.__starship.appendJournalEntry('2026-07-18', { text: 'nur Text', tags: [] }),
    );

    const baseline = page.locator('.journal-mood-band__baseline').first();
    await expect(baseline).toBeVisible();
    const baselineColor = await baseline.evaluate((el) => getComputedStyle(el).backgroundColor);
    const ground = await htmlBackground(page);
    expect(
      contrastRatio(await toRgb(page, baselineColor), await toRgb(page, ground)),
    ).toBeGreaterThanOrEqual(3);
  });

  test('AK2: gefüllte Ring-Spur erfüllt 3:1 gegen den Übersicht-Grund im Hellmodus, Füllung ≠ Spur. Heute 1,01:1', async ({
    page,
  }) => {
    await registerPasskey(page);
    const now = '2026-07-18T12:00:00.000Z';
    const dueToday = '2026-07-18T18:00:00.000Z';
    await skewClock(page, now);
    await page.goto('/uebersicht');
    await seedTask(page, { title: 'Kanten-Sonde Ring', dueAt: dueToday });

    const ring = page.locator('.daily-progress-ring');
    await expect(ring).toBeVisible();
    const fillColor = await ring
      .locator('.daily-progress-ring__fill')
      .evaluate((el) => getComputedStyle(el).stroke);
    const trackColor = await ring
      .locator('.daily-progress-ring__track')
      .evaluate((el) => getComputedStyle(el).stroke);
    const ground = await htmlBackground(page);

    expect(
      contrastRatio(await toRgb(page, fillColor), await toRgb(page, ground)),
    ).toBeGreaterThanOrEqual(3);
    expect(await toRgb(page, fillColor)).not.toEqual(await toRgb(page, trackColor));
  });

  test('Karten-Reset: eine Karte auf dem Grund setzt --border auf den fixen Anker zurück, nicht den Grund-Mix', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/routinen');
    await seedHabit(page, {
      name: 'Kanten-Sonde',
      schedule: 'daily',
      color: null,
      archivedAt: null,
    });

    const card = page.locator('.habit-list__item').first();
    await expect(card).toBeVisible();
    const cardBorder = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
    const borderBase = await resolveColorToken(page, '--border-base');
    const groundBorder = await resolveColorToken(page, '--border');

    expect(await toRgb(page, cardBorder)).toEqual(await toRgb(page, borderBase));
    expect(await toRgb(page, cardBorder)).not.toEqual(await toRgb(page, groundBorder));
  });
});

test.describe('Anmelden (ausgeloggter Kontext)', () => {
  // Eingeloggt leitet /anmelden sofort auf /uebersicht um (shell.spec.ts) — dieser
  // Block braucht einen frischen, ausgeloggten Context statt der geteilten Sitzung.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AK1/AK2: Anmelden rendert seinen Grund vollflächig, Titel erfüllt 4,5:1', async ({
    page,
  }) => {
    await page.goto('/anmelden');

    const groundToken = await resolveColorToken(page, '--ground-anmelden');
    const bgToken = await resolveColorToken(page, '--bg');
    expect(await htmlBackground(page)).toBe(groundToken);
    expect(await bodyBackground(page)).toBe(groundToken);
    expect(groundToken).not.toBe(bgToken);

    const onAccent = await resolveColorToken(page, '--on-accent');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    const headingColor = await elementColor(heading);
    expect(headingColor).toBe(onAccent);
    expect(
      contrastRatio(await toRgb(page, headingColor), await toRgb(page, await htmlBackground(page))),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('AK4: Anmelden dunkelt im Dark Mode ab, Weiß bleibt ≥4,5:1', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/anmelden');

    const lightGroundToken = await resolveColorToken(page, '--ground-anmelden');
    const onGroundLight = await resolveColorToken(page, '--on-ground-light');
    const darkGround = await htmlBackground(page);
    expect(darkGround).not.toBe(lightGroundToken);

    const heading = page.getByRole('heading', { level: 1 });
    const headingColor = await elementColor(heading);
    expect(headingColor).toBe(onGroundLight);
    expect(
      contrastRatio(await toRgb(page, headingColor), await toRgb(page, darkGround)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test('#846 AK3/AK5: --border und --border-strong erfüllen 3:1 gegen den Anmelden-Grund, in beiden Themes', async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/anmelden');
      const ground = await htmlBackground(page);
      const border = await resolveColorToken(page, '--border');
      const borderStrong = await resolveColorToken(page, '--border-strong');
      expect(
        contrastRatio(await toRgb(page, border), await toRgb(page, ground)),
        `--border auf /anmelden (${theme})`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(await toRgb(page, borderStrong), await toRgb(page, ground)),
        `--border-strong auf /anmelden (${theme})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
