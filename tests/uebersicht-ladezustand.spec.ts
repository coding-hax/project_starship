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
 * Das Ladefenster ist ein Tick, kein Netz-Roundtrip (`uebersicht.spec.ts` hält
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
/* AC4: der geladene Zustand bleibt, wie er war                                */
/* -------------------------------------------------------------------------- */

test('nach dem Laden steht der gewohnte Inhalt und aria-busy ist weg (AC4)', async ({ page }) => {
  await page.goto('/uebersicht');
  await seedFullOverview(page);
  await page.reload();

  await expect(page.locator('.daily-progress-meter')).toHaveText('0/2');
  await expect(page.locator('.events-overview__next-title')).toHaveText('Zahnarzt');
  await expect(page.getByText('Heute fällig')).toBeVisible();
  await expect(page.locator('.habit-today__item')).toHaveCount(1);

  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
