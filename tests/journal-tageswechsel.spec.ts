import { expect, test, type Page } from '@playwright/test';
import { FIXED_NOW, installClockAt, registerPasskey, resetAppData, settleJournalHabitBoot, withDb } from './helpers';

/**
 * Tageswechsel im Journal (issue #1050): Wisch, Chevrons, Pfeiltasten — dieselbe
 * Pointer-Events-Geste, dieselbe Schwelle und derselbe Rückstoß wie
 * weather-day.spec.ts (issue #267), gegen `.journal-day-pager` statt
 * `.weather-day-screen`. FIXED_NOW (helpers.ts) ist Samstag, 18. Juli 2026 —
 * mittags UTC, damit "heute" in jeder realistischen Maschinen-Zeitzone
 * derselbe Kalendertag bleibt.
 */

const PASSPHRASE = 'tageswechsel passphrase';
const TODAY_KEY = '2026-07-18';
const YESTERDAY_KEY = '2026-07-17';
const TODAY_LABEL = 'Samstag, 18. Juli';
const YESTERDAY_LABEL = 'Freitag, 17. Juli';

async function setUpEditor(page: Page): Promise<void> {
  await installClockAt(page, FIXED_NOW);
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Passphrase wiederholen').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function openSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeVisible();
}

async function submit(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Eintragen' }).locator('.sheet__action').click();
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeHidden();
}

/** Drives the same Pointer Events the pager listens to (issue #1050) — same
 * reasoning as weather-day.spec.ts's own swipeLeft/swipeRight. */
async function swipeLeft(page: Page, distancePx: number, verticalDriftPx = 0) {
  const container = page.locator('.journal-day-pager');
  const box = (await container.boundingBox())!;
  const clientY = box.y + box.height / 2;
  const startX = box.x + box.width - 20;

  await container.dispatchEvent('pointerdown', { pointerId: 1, clientX: startX, clientY, button: 0, bubbles: true });
  await container.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
  await container.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX - distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
}

/** Same as `swipeLeft`, other direction. */
async function swipeRight(page: Page, distancePx: number, verticalDriftPx = 0) {
  const container = page.locator('.journal-day-pager');
  const box = (await container.boundingBox())!;
  const clientY = box.y + box.height / 2;
  const startX = box.x + 20;

  await container.dispatchEvent('pointerdown', { pointerId: 1, clientX: startX, clientY, button: 0, bubbles: true });
  await container.dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: startX + distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
  await container.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: startX + distancePx,
    clientY: clientY + verticalDriftPx,
    bubbles: true,
  });
}

function eyebrowDate(page: Page) {
  return page.locator('.journal-page__day-nav-date');
}

function cardDate(page: Page) {
  return page.locator('.journal-day-card__date');
}

function previousButton(page: Page) {
  return page.getByRole('button', { name: 'Vorheriger Tag' });
}

function nextButton(page: Page) {
  return page.getByRole('button', { name: 'Nächster Tag' });
}

async function entryCountInDb(entryDate: string): Promise<number> {
  const rows = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_entries WHERE entry_date = $1', [entryDate]),
  );
  return rows.rows[0].n as number;
}

test.beforeEach(async () => {
  await resetAppData();
});

/* -------------------------------------------------------------------------- */
/* AK1: Wischgeste wechselt den Tag / federt zurück                          */
/* -------------------------------------------------------------------------- */

test('AK1: Wisch nach rechts über der Schwelle zeigt den vorherigen Tag', async ({ page }) => {
  await setUpEditor(page);
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);

  await swipeRight(page, 120);

  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);
  await expect(cardDate(page)).toHaveText(YESTERDAY_LABEL);
});

test('AK1: nach dem Zurückwischen bringt ein Wisch nach links wieder zu heute', async ({ page }) => {
  await setUpEditor(page);

  await swipeRight(page, 120);
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);

  await swipeLeft(page, 120);
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
});

test('AK1: eine zu kurze Wischgeste wechselt den Tag nicht und federt zurück', async ({ page }) => {
  await setUpEditor(page);

  await swipeRight(page, 20); // unterhalb der 80px-Schwelle

  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
  await expect(page.locator('.journal-day-pager__track')).toHaveClass(/bouncing/);
});

test('AK1: eine überwiegend senkrechte Geste wechselt den Tag nicht', async ({ page }) => {
  await setUpEditor(page);

  // 120px waagerecht wäre für sich genommen über der Schwelle, aber 200px
  // senkrecht dominieren.
  await swipeRight(page, 120, 200);

  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
});

test('AK1/AK6: ein Wisch nach links auf heute federt zurück — es gibt keinen Tag danach', async ({ page }) => {
  await setUpEditor(page);

  await swipeLeft(page, 120);

  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
  await expect(page.locator('.journal-day-pager__track')).toHaveClass(/bouncing/);
});

/* -------------------------------------------------------------------------- */
/* AK2: senkrechtes Scrollen bleibt uneingeschränkt möglich                   */
/* -------------------------------------------------------------------------- */

test('AK2: der Wisch-Container erlaubt senkrechtes Scrollen (touch-action: pan-y)', async ({ page }) => {
  await setUpEditor(page);

  const touchAction = await page
    .locator('.journal-day-pager')
    .evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toBe('pan-y');
});

/* -------------------------------------------------------------------------- */
/* AK3: nur der Inhalt gleitet, der Seitenkopf steht, kein Übergang beim      */
/* Tageswechsel selbst                                                        */
/* -------------------------------------------------------------------------- */

test('AK3: während der Geste gleitet nur der Inhalt, der Seitenkopf bleibt stehen', async ({ page }) => {
  await setUpEditor(page);
  const headBefore = await page.locator('.page-head').boundingBox();

  const container = page.locator('.journal-day-pager');
  const box = (await container.boundingBox())!;
  const clientY = box.y + box.height / 2;
  const startX = box.x + box.width - 20;
  await container.dispatchEvent('pointerdown', { pointerId: 1, clientX: startX, clientY, button: 0, bubbles: true });
  await container.dispatchEvent('pointermove', { pointerId: 1, clientX: startX - 40, clientY, bubbles: true });

  const trackTransform = await page
    .locator('.journal-day-pager__track')
    .evaluate((el) => getComputedStyle(el).transform);
  expect(trackTransform).not.toBe('none');

  const headDuring = await page.locator('.page-head').boundingBox();
  expect(headDuring).toEqual(headBefore);
  // h1 bleibt „Wie war dein Tag?“, unabhängig vom gezeigten Tag (AK9).
  await expect(page.getByRole('heading', { level: 1, name: 'Wie war dein Tag?' })).toBeVisible();

  await container.dispatchEvent('pointerup', { pointerId: 1, clientX: startX - 40, clientY, bubbles: true });
});

test('AK3: ein echter Tageswechsel setzt den Transform sofort zurück, ohne Federn', async ({ page }) => {
  await setUpEditor(page);

  await swipeRight(page, 120);

  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);
  const track = page.locator('.journal-day-pager__track');
  await expect(track).not.toHaveClass(/bouncing/);
  expect(await track.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

/* -------------------------------------------------------------------------- */
/* AK4/AK6: Chevrons wechseln den Tag, der vorwärts-Chevron ist auf heute     */
/* disabled                                                                   */
/* -------------------------------------------------------------------------- */

test('AK4: Chevrons wechseln den Tag, „Nächster Tag“ ist auf heute disabled', async ({ page }) => {
  await setUpEditor(page);
  await expect(nextButton(page)).toBeDisabled();

  await previousButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);
  await expect(nextButton(page)).toBeEnabled();

  await nextButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
  await expect(nextButton(page)).toBeDisabled();
});

test('AK6: rückwärts gibt es keine Grenze', async ({ page }) => {
  await setUpEditor(page);

  for (let i = 0; i < 10; i += 1) {
    await previousButton(page).click();
  }

  // 10 Tage vor dem 18. Juli 2026 ist der 8. Juli 2026 (ein Mittwoch).
  await expect(eyebrowDate(page)).toHaveText('Mittwoch, 8. Juli');
  await expect(previousButton(page)).toBeEnabled();
});

/* -------------------------------------------------------------------------- */
/* AK5: ArrowLeft/ArrowRight tun dasselbe wie die Chevrons                    */
/* -------------------------------------------------------------------------- */

test('AK5: ArrowLeft/ArrowRight wechseln den Tag wie die Chevrons', async ({ page }) => {
  await setUpEditor(page);

  await page.keyboard.press('ArrowLeft');
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);

  await page.keyboard.press('ArrowRight');
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
});

test('AK5: ArrowLeft im Eintrag-Textfeld wechselt den Tag nicht (Cursor-Bewegung bleibt Cursor-Bewegung)', async ({
  page,
}) => {
  await setUpEditor(page);
  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Text mit Cursor');
  await page.getByLabel('Journal-Text').press('ArrowLeft');

  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeVisible();
  // Sheet schließen, ohne den Eintrag abzusenden — der Cursor-Move darf den
  // Tag ohnehin nicht gewechselt haben, unabhängig vom Sheet-Zustand danach.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Eintragen' })).toBeHidden();

  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
});

/* -------------------------------------------------------------------------- */
/* AK7: leerer Tag zeigt das leere Zeilenfeld; ein Eintrag landet auf dem     */
/* gezeigten Tag, nicht auf heute                                             */
/* -------------------------------------------------------------------------- */

test('AK7: ein Tag ohne Eintrag zeigt „Deine Zeile für heute“, auch wenn es nicht heute ist', async ({ page }) => {
  await setUpEditor(page);

  await previousButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);
  await expect(page.locator('.journal-day-card--empty')).toContainText('Deine Zeile für heute');
  await expect(page.locator('.journal-day-card__eyebrow')).toHaveText('Gestern');
});

test('AK7: ein auf einem älteren Tag angelegter Eintrag landet auf diesem Tag, nicht auf heute', async ({ page }) => {
  await setUpEditor(page);

  await previousButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);

  await openSheet(page);
  await page.getByLabel('Journal-Text').fill('Auf gestern geschrieben');
  await submit(page);

  await expect(page.locator('.journal-day-card__line')).toHaveText('Auf gestern geschrieben');

  await nextButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);
  await expect(page.locator('.journal-day-card--empty')).toBeVisible();

  // Server-Sync ist sonst passiv (alle 30s) — explizit anstoßen, statt auf das
  // Intervall zu warten (Muster wie jede andere withDb()-Prüfung in journal.spec.ts).
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => entryCountInDb(YESTERDAY_KEY)).toBe(1);
  expect(await entryCountInDb(TODAY_KEY)).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* AK8: kein eigener Netzaufruf durch den Tageswechsel, funktioniert offline  */
/* -------------------------------------------------------------------------- */

test('AK8: ein Tageswechsel löst keinen eigenen Netzaufruf aus und funktioniert offline', async ({
  page,
  context,
}) => {
  await setUpEditor(page);
  await settleJournalHabitBoot(page);
  await context.setOffline(true);

  const requestUrls: string[] = [];
  page.on('request', (request) => requestUrls.push(request.url()));

  await swipeRight(page, 120);
  await expect(eyebrowDate(page)).toHaveText(YESTERDAY_LABEL);

  await nextButton(page).click();
  await expect(eyebrowDate(page)).toHaveText(TODAY_LABEL);

  expect(requestUrls).toEqual([]);

  await context.setOffline(false);
});

/* -------------------------------------------------------------------------- */
/* prefers-reduced-motion: kein Federn, der Tag schlägt einfach um            */
/* -------------------------------------------------------------------------- */

test('bei reduzierter Bewegung hat der Rückstoß keine Übergangsdauer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setUpEditor(page);

  await swipeRight(page, 20); // unterhalb der Schwelle -> Rückstoß-Pfad

  const transitionDuration = await page
    .locator('.journal-day-pager__track')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  // Chromium serialisiert sehr kleine Werte in Exponentialschreibweise (z. B. "1e-05s").
  expect(parseFloat(transitionDuration)).toBeLessThan(0.001);
});
