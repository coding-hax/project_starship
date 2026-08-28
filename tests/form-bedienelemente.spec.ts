import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMeteoForecastBody, registerPasskey, resetAppData, selectView } from './helpers';

/**
 * Bedienelemente-Feinschliff (issue #867, T3 von #860): FAB-Pille, aktiver
 * Reiter, Häkchen. Ein Test je AK, gemessen per getComputedStyle/
 * getBoundingClientRect statt per Augenschein — Vorlage: figuren.spec.ts
 * (Reduce-Motion, animationName) und form-radien.spec.ts (Token-Probe,
 * Überlauf hell/dunkel).
 */
test.describe.configure({ timeout: 120_000 });

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route(GARMIN_SYNC_PATTERN, (route) =>
    route.fulfill({
      json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
    }),
  );
  await page.route(OPEN_METEO_PATTERN, (route) =>
    route.fulfill({
      json: openMeteoForecastBody({ dates: ['2026-07-18'], tempsMax: [20], tempsMin: [10] }),
    }),
  );
});

/** Mirrors form-radien.spec.ts's own probe-span technique for a var()-resolved value. */
async function resolveRadiusToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.borderRadius = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).borderRadius;
    probe.remove();
    return value;
  }, token);
}

async function resolveShadowToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.boxShadow = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).boxShadow;
    probe.remove();
    return value;
  }, token);
}

async function resolveColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssVar) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${cssVar})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

/**
 * `color-mix(..., var(--accent) …)` needs the document's cascade to resolve the
 * custom property — a canvas 2D context has no element context, so assigning
 * the raw expression straight to `fillStyle` silently no-ops (canvas keeps its
 * opaque-black default). Resolve it through a probe span first, exactly like
 * `resolveRadiusToken`/`resolveColorToken` above.
 */
async function resolveMixColor(page: Page, expr: string): Promise<string> {
  return page.evaluate((e) => {
    const probe = document.createElement('span');
    probe.style.background = e;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, expr);
}

/**
 * getComputedStyle can serialize a color-mix()/oklab-sourced colour differently
 * depending on the property it lands on (nav-order.mobile.spec.ts documents the
 * same oklch/oklab drift) — painting into a 1×1 canvas and reading the pixel
 * back is source-agnostic and keeps the alpha channel a `transparent` mix needs.
 */
async function toRgba(page: Page, color: string): Promise<[number, number, number, number]> {
  return page.evaluate((c) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a] as [number, number, number, number];
  }, color);
}

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

const JOURNAL_PASSPHRASE = 'form-bedienelemente passphrase';

/** The journal FAB only mounts once the gate is unlocked (journal-gate.tsx) —
 * every route iteration below that touches /journal runs the setup flow once
 * (mirrors journal-suche.spec.ts's own setUpEditor), not a plain goto(). */
async function openJournal(page: Page): Promise<void> {
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(JOURNAL_PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(JOURNAL_PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function gotoRoute(page: Page, path: string): Promise<void> {
  if (path === '/journal') {
    await openJournal(page);
  } else {
    await page.goto(path);
  }
}

interface FabRoute {
  path: string;
  ariaName: string;
  text: string;
}

const FAB_ROUTES: FabRoute[] = [
  { path: '/aufgaben', ariaName: 'Aufgabe erfassen', text: 'Aufgabe' },
  { path: '/routinen', ariaName: 'Routine anlegen', text: 'Routine' },
  { path: '/journal', ariaName: 'Eintragen', text: 'Eintrag' },
  { path: '/kalender', ariaName: 'Termin erfassen', text: 'Termin' },
];

test('AK1: der FAB ist eine beschriftete Pille, der volle aria-Name bleibt unverändert', async ({
  page,
}) => {
  await registerPasskey(page);
  const surfaceToken = await resolveColorToken(page, '--surface');
  const pillToken = await resolveRadiusToken(page, '--radius-pill');

  for (const route of FAB_ROUTES) {
    await gotoRoute(page, route.path);
    const fab = page.getByRole('button', { name: route.ariaName });
    await expect(fab, `${route.path}: Locator mit vollem aria-Namen`).toBeVisible();
    await expect(fab.locator('.fab__label'), `${route.path}: sichtbarer Kurztext`).toHaveText(
      route.text,
    );

    // getComputedStyle().height, nicht boundingBox(): der FAB atmet (AK2), eine
    // Bounding-Box mitten im `breathe`-Zyklus trüge den Skalenhub (bis zu 1.04×)
    // mit — die deklarierte Boxgröße bleibt davon unberührt.
    const style = await fab.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        height: s.height,
        paddingLeft: s.paddingLeft,
        paddingRight: s.paddingRight,
        borderRadius: s.borderRadius,
        background: s.backgroundColor,
        columnGap: s.columnGap,
      };
    });
    expect(style.height, `${route.path}: Höhe 58px`).toBe('58px');
    expect(style.paddingLeft, `${route.path}: padding-inline links`).toBe('24px');
    expect(style.paddingRight, `${route.path}: padding-inline rechts`).toBe('24px');
    expect(style.borderRadius, `${route.path}: Radius = --radius-pill`).toBe(pillToken);
    expect(style.background, `${route.path}: Grund = --surface`).toBe(surfaceToken);
    expect(style.columnGap, `${route.path}: Abstand Icon/Label`).toBe('10px');

    const iconSize = await fab.locator('.fab__icon').evaluate((el) => getComputedStyle(el).fontSize);
    expect(iconSize, `${route.path}: Icon-Größe`).toBe('20px');
  }
});

/**
 * Der Skalenhub sitzt auf `.fab__icon`/`.fab__label`, nicht auf `.fab` selbst
 * (issue #867: ein `transform` direkt am Button ließ dessen eigene
 * getBoundingClientRect nie zur Ruhe kommen — Playwright's Klick-Stabilitäts-
 * check auf jedem bestehenden `fab.click()` im Rest der Suite lief in den
 * 30s-Timeout). Beide Kinder teilen sich dieselbe `animation-name`.
 */
async function fabAnimationName(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.fab__icon')!).animationName);
}

test('AK2: der FAB atmet, OS-Präferenz und der App-Schalter halten ihn an', async ({ page }) => {
  await registerPasskey(page);

  // Gegenprobe zuerst: ohne Reduce-Motion läuft `breathe`.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/aufgaben');
  expect(await fabAnimationName(page), 'atmet ohne Reduce-Motion').toBe('breathe');

  // (a) OS-Präferenz.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/aufgaben');
  expect(await fabAnimationName(page), 'hält per OS-Präferenz an').toBe('none');

  // (b) App-Schalter „Bewegung reduzieren" — ohne OS-Präferenz, damit dieser
  // Teil wirklich den Schalter prüft (Vorlage: figuren.spec.ts AK4/AK5).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/einstellungen');
  const toggle = page.getByRole('switch', { name: 'Bewegung reduzieren' });
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');

  await page.goto('/aufgaben');
  expect(await fabAnimationName(page), 'hält per App-Schalter an').toBe('none');
});

interface NavRoute {
  path: string;
  label: string;
}

const NAV_ROUTES: NavRoute[] = [
  { path: '/uebersicht', label: 'Übersicht' },
  { path: '/aufgaben', label: 'Aufgaben' },
  { path: '/routinen', label: 'Routinen' },
  { path: '/kalender', label: 'Kalender' },
  { path: '/journal', label: 'Journal' },
  { path: '/aktivitaeten', label: 'Aktivitäten' },
];

async function pseudoProp(locator: Locator, pseudo: string, prop: string): Promise<string> {
  return locator.evaluate(
    (el, { pseudo, prop }) => getComputedStyle(el, pseudo).getPropertyValue(prop),
    { pseudo, prop },
  );
}

test('AK3: der aktive Reiter trägt seine Pille hinter dem Icon, ein inaktiver nicht', async ({
  page,
}) => {
  await registerPasskey(page);

  const expectedPillColor = await resolveMixColor(
    page,
    'color-mix(in oklab, var(--accent) 15%, transparent)',
  );
  const expectedPill = await toRgba(page, expectedPillColor);
  const pillToken = await resolveRadiusToken(page, '--radius-pill');
  const emphasisWeight = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--weight-emphasis').trim(),
  );

  for (const route of NAV_ROUTES) {
    await page.goto(route.path);
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });

    const activeLink = nav.getByRole('link', { name: route.label });
    const activeIcon = activeLink.locator('.nav__icon');
    const [width, height, radius, background] = await Promise.all([
      pseudoProp(activeIcon, '::before', 'width'),
      pseudoProp(activeIcon, '::before', 'height'),
      pseudoProp(activeIcon, '::before', 'border-radius'),
      pseudoProp(activeIcon, '::before', 'background-color'),
    ]);
    expect(width, `${route.path}: Pillenbreite`).toBe('40px');
    expect(height, `${route.path}: Pillenhöhe`).toBe('28px');
    expect(radius, `${route.path}: Pillenradius`).toBe(pillToken);
    expect(await toRgba(page, background), `${route.path}: Pillenfarbe`).toEqual(expectedPill);

    const activeWeight = await activeLink.locator('.nav__label').evaluate((el) => getComputedStyle(el).fontWeight);
    expect(activeWeight, `${route.path}: aktives Label ist Emphasis`).toBe(emphasisWeight);

    const inactiveRoute = NAV_ROUTES.find((candidate) => candidate.path !== route.path)!;
    const inactiveLink = nav.getByRole('link', { name: inactiveRoute.label });
    const inactiveContent = await pseudoProp(inactiveLink.locator('.nav__icon'), '::before', 'content');
    expect(inactiveContent, `${route.path}: inaktiver Reiter ohne Pille`).toBe('none');
  }

  await page.goto('/aufgaben');
  const shadowToken = await resolveShadowToken(page, '--shadow-float');
  const navBarShadow = await page
    .locator('.nav__bar')
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(navBarShadow, '.nav__bar trägt --shadow-float').toBe(shadowToken);
});

test('AK4: die Aufgaben-Checkbox ist ein gezeichneter Kreis mit Häkchen', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');
  // Ohne dueAt fällt die Sonde unter die "Woche"-Standardansicht (issue #705) —
  // "Alle" macht sie unabhängig vom Fälligkeitsdatum sichtbar (Vorlage: tasks.spec.ts).
  await selectView(page, 'Alle');
  const title = 'AK4-Sonde';
  await seedTask(page, { title });

  const checkbox = page.getByRole('checkbox', { name: `${title} als erledigt markieren` });
  await expect(checkbox).toBeVisible();

  const wrap = checkbox.locator('xpath=..');
  const wrapBox = await wrap.boundingBox();
  expect(wrapBox!.width, 'Trefferfeld ≥44px breit').toBeGreaterThanOrEqual(44);
  expect(wrapBox!.height, 'Trefferfeld ≥44px hoch').toBeGreaterThanOrEqual(44);

  const box = await checkbox.boundingBox();
  expect(Math.round(box!.width), 'Kreis 30px breit').toBe(30);
  expect(Math.round(box!.height), 'Kreis 30px hoch').toBe(30);

  const uncheckedStyle = await checkbox.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(uncheckedStyle, 'unabgehakt ohne Füllung').toBe('rgba(0, 0, 0, 0)');

  const expectedBorderColor = await resolveMixColor(
    page,
    'color-mix(in oklab, var(--accent) 55%, transparent)',
  );
  const expectedBorder = await toRgba(page, expectedBorderColor);
  const borderColor = await checkbox.evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(await toRgba(page, borderColor), 'Rand in gemischter Bereichsfarbe').toEqual(expectedBorder);

  await checkbox.click();
  // "Alle" zeigt seit #814 nur noch Offenes — die abgehakte Zeile verlässt die
  // Ansicht sofort. "Erledigt" macht sie für die Optik-Prüfung unten wieder
  // sichtbar (Vorlage: tasks.spec.ts:787 "ein Klick auf die Checkbox erledigt
  // die Aufgabe genauso wie der Swipe").
  await selectView(page, 'Erledigt');
  await expect(checkbox).toBeChecked();

  const accentToken = await resolveColorToken(page, '--accent');
  const checkedBackground = await checkbox.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(checkedBackground, 'abgehakt gefüllt in --accent').toBe(accentToken);

  const afterSize = await checkbox.evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return { width: s.width, height: s.height };
  });
  expect(afterSize.width, 'Häkchen sichtbar (Breite)').not.toBe('0px');
  expect(afterSize.height, 'Häkchen sichtbar (Höhe)').not.toBe('0px');
});

interface OverflowRoute {
  path: string;
  header: (page: Page) => Locator;
}

// Alle sechs von diesem Ticket berührten Routen (FAB: aufgaben/routinen/journal/
// kalender; Nav: alle sechs; Häkchen: aufgaben) — Kopf-Locator wie form-radien.spec.ts.
const OVERFLOW_ROUTES: OverflowRoute[] = [
  { path: '/uebersicht', header: (page) => page.locator('.uebersicht__title-row') },
  { path: '/aufgaben', header: (page) => page.getByRole('heading', { level: 1, name: 'Aufgaben' }) },
  {
    path: '/routinen',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Routinen verwalten' }),
  },
  { path: '/kalender', header: (page) => page.locator('.calendar-view__header') },
  { path: '/journal', header: (page) => page.locator('.journal-page__title-row') },
  {
    path: '/aktivitaeten',
    header: (page) => page.getByRole('heading', { level: 1, name: 'Aktivitäten' }),
  },
];

for (const scheme of ['light', 'dark'] as const) {
  const label = scheme === 'light' ? 'Hell' : 'Dunkel';
  test(`AK-Ü: kein Überlauf nach FAB/Reiter/Häkchen, ${label}`, async ({ page }) => {
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: scheme });

    for (const route of OVERFLOW_ROUTES) {
      await gotoRoute(page, route.path);
      const header = route.header(page);
      await expect(header, `Kopf sichtbar auf ${route.path} (${scheme})`).toBeVisible();

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `waagerechter Überlauf auf ${route.path} (${scheme})`).toBeLessThanOrEqual(
        clientWidth,
      );

      const { scrollHeight, clientHeight } = await header.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(
        scrollHeight,
        `Kopf auf ${route.path} (${scheme}): scrollHeight ${scrollHeight} vs. clientHeight ${clientHeight}`,
      ).toBeLessThanOrEqual(clientHeight);
    }
  });
}
