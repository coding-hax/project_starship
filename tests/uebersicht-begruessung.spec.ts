import { expect, test, type Page } from '@playwright/test';
import { berlinInstant } from '@/push/schedule';
import {
  expectUebersichtLoaded,
  freezeClock,
  installClockAt,
  registerPasskey,
  resetAppData,
  skewClock,
} from './helpers';

/**
 * issue #862: die Titel-Überschrift auf /uebersicht ist eine Begrüßung nach
 * Ortszeit statt eines festen „Übersicht". "Ortszeit" heißt Europe/Berlin
 * (greeting.ts) — `berlinInstant` baut den passenden UTC-Instant, damit die
 * Grenzzeiten unabhängig von der Host-Zeitzone stimmen (CI läuft in UTC, ein
 * Entwickler-Mac ggf. nicht). `installClockAt` muss vor der ersten Navigation
 * stehen (siehe ihr Docstring) — nur so sieht der allererste Client-Render
 * dieselbe Ortszeit, die die Assertions gleich danach prüfen.
 */
const DAY = '2026-07-18'; // Saturday, dieselbe Kalenderdate wie FIXED_NOW anderswo.

function berlin(hours: number, minutes: number): string {
  return berlinInstant(DAY, hours * 60 + minutes).toISOString();
}

function heading(page: Page) {
  return page.locator('[data-ground="uebersicht"] h1');
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await page.route('https://api.open-meteo.com/**', (route) => route.abort('failed'));
});

test('AK4: Gute Nacht bis 04:59, Guten Morgen ab 05:00', async ({ page }) => {
  await installClockAt(page, berlin(4, 59));
  await registerPasskey(page);
  await expect(heading(page)).toHaveText('Gute Nacht');

  await skewClock(page, berlin(5, 0));
  await page.reload();
  await expect(heading(page)).toHaveText('Guten Morgen');
});

test('AK4: Guten Morgen bis 10:59, Guten Mittag ab 11:00', async ({ page }) => {
  await installClockAt(page, berlin(10, 59));
  await registerPasskey(page);
  await expect(heading(page)).toHaveText('Guten Morgen');

  await skewClock(page, berlin(11, 0));
  await page.reload();
  await expect(heading(page)).toHaveText('Guten Mittag');
});

test('AK4: Guten Mittag bis 16:59, Guten Abend ab 17:00', async ({ page }) => {
  await installClockAt(page, berlin(16, 59));
  await registerPasskey(page);
  await expect(heading(page)).toHaveText('Guten Mittag');

  await skewClock(page, berlin(17, 0));
  await page.reload();
  await expect(heading(page)).toHaveText('Guten Abend');
});

test('AK4: Guten Abend bis 21:59, Gute Nacht ab 22:00', async ({ page }) => {
  await installClockAt(page, berlin(21, 59));
  await registerPasskey(page);
  await expect(heading(page)).toHaveText('Guten Abend');

  await skewClock(page, berlin(22, 0));
  await page.reload();
  await expect(heading(page)).toHaveText('Gute Nacht');
});

test('AK2: der Titel wechselt an einer Grenze, ohne dass die Seite neu lädt', async ({ page }) => {
  await installClockAt(page, berlin(16, 59));
  await registerPasskey(page);
  await expect(heading(page)).toHaveText('Guten Mittag');

  // useNow tickt per echtem setInterval, das eine gefakte, vorgespulte Uhr normal
  // weiterdreht (src/ui/use-now.ts) — kein page.reload() zwischen den beiden Prüfungen.
  await freezeClock(page);
  await page.clock.fastForward(2 * 60 * 1000);

  await expect(heading(page)).toHaveText('Guten Abend');
});

test('AK3: kein Hydration-Mismatch beim Laden von /uebersicht, egal welche Ortszeit gerade gilt', async ({
  page,
}) => {
  await installClockAt(page, berlin(17, 0));
  await registerPasskey(page);

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // registerPasskey's Navigation lief vor den obigen Listenern — neu laden für
  // einen frischen SSR+Hydration-Zyklus mit bereits installierter Fake-Uhr.
  await page.reload();

  await expectUebersichtLoaded(page);
  await expect(heading(page)).toHaveText('Guten Abend');
  expect(consoleErrors.filter((text) => /hydrat|did.?n.?t match/i.test(text))).toEqual([]);
});
