import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData, skewClock } from './helpers';

/**
 * Der Ladezustand der Übersicht (issue #642).
 *
 * Drei Sektionen (Termine, Aufgaben, Routinen) rendern `null`, solange ihre
 * Live-Query läuft. Einzeln ist das die dokumentierte Anti-Shift-Maßnahme,
 * zusammen auf einem Screen klappt jeder Block bei seinem eigenen Tick auf und
 * schiebt alles darunter nach unten — Smooth-Regel 3, verschoben auf die erste
 * Sekunde nach dem Öffnen.
 *
 * Der Fortschrittsring und die Streak-Karte sind seit issue #652 nicht mehr
 * Teil dieser Gruppe: der Ring sitzt jetzt in der immer sichtbaren Titelzeile
 * (fest bemessener Slot, siehe daily-progress-ring.tsx — kein Beitrittsgrund
 * zum gemeinsamen Enthüllungspunkt mehr), die Streak-Karte zog auf
 * /routinen um.
 *
 * Das Ladefenster ist ein Tick, kein Netz-Roundtrip (`aktivitaeten.spec.ts` hält
 * das schon fest: „nothing to gate it open long enough to observe on a real
 * page"). Eine „miss Position, warte, miss nochmal"-Prüfung liefe deshalb immer
 * erst im eingeschwungenen Zustand und wäre auch ohne Fix grün. Gemessen wird
 * hier stattdessen mit den Instrumenten des Browsers selbst, beide vor dem
 * Laden installiert: die `layout-shift`-Einträge der Layout Instability API
 * (AC1) und ein rAF-Abtaster, der je Frame festhält, welcher Block sichtbar
 * geworden ist (AC2/AC3).
 */

const NOW = '2026-07-15T12:00:00.000Z';
const TODAY = '2026-07-15';

/** Ein Block je Sektion der Übersicht — der Selektor trifft geladenen wie leeren Zustand. */
const BLOCKS = {
  termine: '.events-overview__next, .events-overview__empty',
  aufgaben: '.task-list, .task-list__empty',
  routinen: '.habit-today, .habit-today__empty',
} as const;

interface ShiftEntry {
  value: number;
  sources: string[];
}

interface RevealProbe {
  frame: number;
  /** Blockname → Frame, in dem er zum ersten Mal sichtbar war. */
  firstVisibleFrame: Record<string, number>;
  /** Blöcke, die sichtbar waren und danach wieder verschwanden (Kollaps, AC3). */
  vanished: string[];
}

declare global {
  interface Window {
    __shifts: ShiftEntry[];
    __reveal: RevealProbe;
  }
}

/**
 * Läuft vor jedem Skript der Seite. Kein DOM-Anfassen hier — `addInitScript`
 * feuert, bevor `document.head` existiert, angehängte Knoten verpuffen still.
 */
async function installProbes(page: Page, blocks: Record<string, string>): Promise<void> {
  await page.addInitScript((selectors: Record<string, string>) => {
    window.__shifts = [];
    window.__reveal = { frame: 0, firstVisibleFrame: {}, vanished: [] };

    const describe = (node: Node | null): string => {
      if (!(node instanceof Element)) return 'detached';
      const className = typeof node.className === 'string' ? node.className : '';
      return `${node.tagName.toLowerCase()}${className ? `.${className.trim().split(/\s+/).join('.')}` : ''}`;
    };

    /**
     * Die Layout Instability API liefert je Quelle das Rechteck vor und nach dem
     * Sprung. Ohne sie sagt ein roter Lauf nur, WELCHES Element gesprungen ist —
     * mit ihnen auch, ob es vertikal, horizontal, breiter oder höher wurde. Das
     * entscheidet zwischen Ursachen, die sonst nur zu raten sind (issue #652:
     * vier Runden gingen auf Verdacht ins Leere, weil diese Zahl fehlte).
     */
    const rect = (r?: DOMRectReadOnly): string =>
      r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}` : '?';

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: Array<{
          node: Node | null;
          previousRect?: DOMRectReadOnly;
          currentRect?: DOMRectReadOnly;
        }>;
      })[]) {
        if (entry.hadRecentInput) continue;
        window.__shifts.push({
          value: entry.value,
          sources: (entry.sources ?? []).map(
            (source) =>
              `${describe(source.node)} [${rect(source.previousRect)} → ${rect(source.currentRect)}]`,
          ),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });

    const wasVisible = new Set<string>();
    const sample = () => {
      const frame = window.__reveal.frame++;
      for (const [name, selector] of Object.entries(selectors)) {
        const element = document.querySelector(selector);
        // `opacityProperty` zählt die Blende mit: solange der Wrapper auf 0 steht,
        // ist der Block nicht sichtbar, auch wenn er längst im DOM hängt.
        const visible =
          element !== null &&
          element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        if (visible && !(name in window.__reveal.firstVisibleFrame)) {
          window.__reveal.firstVisibleFrame[name] = frame;
          wasVisible.add(name);
        } else if (!visible && wasVisible.has(name) && !window.__reveal.vanished.includes(name)) {
          window.__reveal.vanished.push(name);
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, blocks);
}

async function seed(page: Page, table: string, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    ({ table, payload }) =>
      window.__starship.mutate({
        table: table as Parameters<typeof window.__starship.mutate>[0]['table'],
        op: 'upsert',
        payload,
      }),
    { table, payload },
  );
}

/** Eine Übersicht, auf der jeder der sechs Blöcke etwas zu zeigen hat. */
async function seedFullOverview(page: Page): Promise<void> {
  await seed(page, 'tasks', { title: 'Heute fällig', dueAt: `${TODAY}T18:00:00.000Z` });
  await seed(page, 'habits', {
    name: 'Lesen',
    schedule: 'daily',
    color: null,
    archivedAt: null,
  });
  await seed(page, 'events', {
    title: 'Zahnarzt',
    allDay: false,
    startsAt: `${TODAY}T13:00:00.000Z`,
    endsAt: `${TODAY}T14:00:00.000Z`,
    startDate: null,
    endDate: null,
    category: null,
  });
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Alles auf der Übersicht liest aus IndexedDB (CLAUDE.md Regel 8). Das Wetter ist
  // die Ausnahme und hängt an einem echten Fetch — der bleibt hier draußen, sonst
  // leckt er in die Messung (und in jede andere /uebersicht-Spec).
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
  // No target: every test in this file opens with its own goto, so loading
  // /uebersicht here would only be thrown away (issue #1075).
  await registerPasskey(page, null);
  await skewClock(page, NOW);
});

/* -------------------------------------------------------------------------- */
/* AC1: kein Layout-Shift beim Öffnen                                          */
/* -------------------------------------------------------------------------- */

test('das Öffnen der vollen Übersicht erzeugt keinen einzigen Layout-Shift (AC1)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedFullOverview(page);

  await installProbes(page, BLOCKS);
  await page.reload();

  await expect(page.locator('.daily-progress-ring')).toBeVisible();
  await expect(page.locator('.habit-today')).toBeVisible();

  const shifts = await page.evaluate(() => window.__shifts);
  const total = shifts.reduce((sum, shift) => sum + shift.value, 0);

  // Die Quellen stehen mit in der Meldung: ein roter Lauf sagt dann, welches
  // Element geschoben hat, statt nur „irgendwas hat sich bewegt". Schwelle
  // 0,002 statt Nulltoleranz nur für das eine bekannte Artefakt (menschlich
  // freigegeben, issue #920 Runde 5, Präzedenzfall #867 AK6 in
  // tests/formsprache.spec.ts): CI läuft auf Linux, wo next/font's
  // Fallback-Metrik-Anpassung für --font-nunito-stable gegen ein dort nicht
  // installiertes „Arial" berechnet ist — der FAB (`button.fab`) schrumpft
  // dadurch minimal, bevor Nunito einschwingt. Auf dem Zielgerät
  // (Apple/SF Pro Rounded, keine Nunito-Ladung) tritt das nachweislich nie
  // auf. Jeder andere Schiebe-Ursprung bleibt weiter auf Nulltoleranz.
  const unexpectedSources = shifts
    .flatMap((shift) => shift.sources)
    .filter((source) => !source.startsWith('button.fab'));
  expect(unexpectedSources).toEqual([]);
  expect(total).toBeLessThan(0.002);
});

test('auch die leere Übersicht öffnet ohne Layout-Shift (AC1)', async ({ page }) => {
  await installProbes(page, BLOCKS);
  await page.goto('/uebersicht');

  await expect(page.locator('.habit-today__empty')).toBeVisible();

  const shifts = await page.evaluate(() => window.__shifts);
  const total = shifts.reduce((sum, shift) => sum + shift.value, 0);

  // Dieselbe Schwelle, derselbe Grund wie im vorherigen Test dieser Datei.
  const unexpectedSources = shifts
    .flatMap((shift) => shift.sources)
    .filter((source) => !source.startsWith('button.fab'));
  expect(unexpectedSources).toEqual([]);
  expect(total).toBeLessThan(0.002);
});

/* -------------------------------------------------------------------------- */
/* AC2: gemeinsame Enthüllung                                                  */
/* -------------------------------------------------------------------------- */

test('alle Blöcke werden im selben Frame sichtbar, nicht nacheinander (AC2)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedFullOverview(page);

  await installProbes(page, BLOCKS);
  await page.reload();

  await expect(page.locator('.habit-today')).toBeVisible();
  await expect(page.locator('.events-overview__next')).toBeVisible();

  const reveal = await page.evaluate(() => window.__reveal);
  const frames = Object.values(reveal.firstVisibleFrame);

  // Jeder gemessene Block muss aufgetaucht sein — sonst misst der Test nichts.
  expect(Object.keys(reveal.firstVisibleFrame).sort()).toEqual(
    ['aufgaben', 'routinen', 'termine'].sort(),
  );
  expect(new Set(frames).size).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* AC3: kein Platzhalter, der wieder verschwindet                              */
/* -------------------------------------------------------------------------- */

test('auf der leeren Übersicht erscheint kein Block, der danach wieder verschwindet (AC3)', async ({
  page,
}) => {
  await installProbes(page, BLOCKS);
  await page.goto('/uebersicht');

  await expect(page.locator('.habit-today__empty')).toBeVisible();
  await expect(page.locator('.events-overview__empty')).toBeVisible();

  const reveal = await page.evaluate(() => window.__reveal);
  expect(reveal.vanished).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* AC4: der geladene Zustand bleibt, wie er war                                */
/* -------------------------------------------------------------------------- */

test('nach dem Laden steht der gewohnte Inhalt und aria-busy ist weg (AC4)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedFullOverview(page);
  await page.reload();

  await expect(page.locator('.daily-progress-ring')).toHaveText('0/2');
  await expect(page.locator('.events-overview__next-title')).toHaveText('Zahnarzt');
  await expect(page.getByText('Heute fällig')).toBeVisible();
  await expect(page.locator('.habit-today__item')).toHaveCount(1);

  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* AC5: das Wetter hält die Seite nicht auf                                    */
/* -------------------------------------------------------------------------- */

test('ein hängender Wetter-Request verzögert den übrigen Inhalt nicht (AC5)', async ({ page }) => {
  // Nie beantwortet — der Fetch bleibt für die ganze Dauer des Tests offen.
  await page.route('https://api.open-meteo.com/**', () => {});

  await page.goto('/uebersicht');
  await seedFullOverview(page);
  await page.reload();

  await expect(page.locator('.daily-progress-ring')).toBeVisible();
  await expect(page.locator('.habit-today')).toBeVisible();
  await expect(page.locator('.weather-forecast__day--skeleton').first()).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* AC6/AC7: reduzierte Bewegung, Dark Mode                                     */
/* -------------------------------------------------------------------------- */

test('bei reduzierter Bewegung ist die Enthüllung ohne Übergangsdauer (AC6)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/uebersicht');
  await seedFullOverview(page);
  await page.reload();

  await expect(page.locator('.habit-today')).toBeVisible();

  const duration = await page
    .locator('.overview-ready')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  for (const value of duration.split(',')) {
    expect(parseFloat(value)).toBeLessThan(0.001);
  }
});

test('im Dark Mode wird derselbe Inhalt enthüllt (AC7)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/uebersicht');
  await seedFullOverview(page);
  await page.reload();

  await expect(page.locator('.daily-progress-ring')).toHaveText('0/2');
  await expect(page.locator('.habit-today__item')).toHaveCount(1);
  await expect(page.locator('.overview-ready')).toBeVisible();
});
