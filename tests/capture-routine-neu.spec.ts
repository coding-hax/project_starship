import { expect, test, type Page } from '@playwright/test';
import { installClockAt, registerPasskey, resetAppData, withDb } from './helpers';

/**
 * issue #758: trifft die Spracherfassung auf `/uebersicht` bei Art „Routine" keine
 * bestehende Gewohnheit, kann die Routine-Auswahl jetzt explizit eine **neue**
 * Routine mit dem eingegebenen/erkannten Namen anlegen (analog Aufgabe/Termin) —
 * ein Test je AK1–AK7, Muster aus `tests/capture-art.spec.ts`.
 */

const CAPTURE_LABEL = 'Aufgabe erfassen';

function captureButton(page: Page) {
  return page.getByRole('button', { name: CAPTURE_LABEL });
}

function captureDialog(page: Page) {
  return page.getByRole('dialog', { name: CAPTURE_LABEL });
}

function captureTitleField(page: Page) {
  return page.getByRole('textbox', { name: 'Titel der Aufgabe' });
}

function artChip(page: Page, label: string) {
  return page.getByRole('button', { name: `Art, ${label}` });
}

/** #780 AK1: solange keine Art erkannt ist, trägt der Chip kein Wert-Suffix mehr —
 * `exact: true`, sonst matcht "Art" auch als Substring von "Art, Aufgabe" etc. */
function artChipEmpty(page: Page) {
  return page.getByRole('button', { name: 'Art', exact: true });
}

/** `exact: true` matters here: "Routine" (unset) is otherwise a substring
 * match of the Art-Chip's own "Art, Routine". */
function routineChip(page: Page, label?: string) {
  return page.getByRole('button', { name: label ? `Routine, ${label}` : 'Routine', exact: true });
}

function newRoutineOption(page: Page, name: string) {
  return page.getByRole('radio', { name: `Neue Routine anlegen: „${name}"` });
}

async function seedHabit(page: Page, name: string): Promise<void> {
  await page.evaluate(
    (habitName) =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: habitName, schedule: 'daily', color: null, archivedAt: null },
      }),
    name,
  );
}

/** Öffnet die Erfassung, wechselt die Art von Hand auf „Routine" und tippt den
 * Namen — der Weg, über den `newRoutine` #758 AK2 erst erreichbar wird (die
 * Grammatik selbst erkennt kein "neue Routine X"). */
async function openRoutineDraft(page: Page, name: string) {
  await captureButton(page).click();
  await artChipEmpty(page).click();
  await page.getByRole('radio', { name: 'Routine' }).click();
  await captureTitleField(page).fill(name);
  await routineChip(page).click();
}

test.beforeEach(async ({ page }) => {
  await resetAppData();
  // Kein echtes Absenden nötig: Anlegen läuft lokal-first über die Outbox
  // (CLAUDE.md Regel 8) — abgesperrt, damit ein versehentlicher Fetch sofort
  // auffiele statt still durchzulaufen. Nur der Offline-Test (AK7) hebt das
  // gezielt wieder auf.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));
  await installClockAt(page);
  await registerPasskey(page);
});

test('AK1: auch ohne bestehende Gewohnheit ist die Art „Routine" wählbar', async ({ page }) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await artChipEmpty(page).click();

  await expect(page.getByRole('radio', { name: 'Routine' })).toBeEnabled();
});

test('AK2: ohne aufgelösten Treffer bietet die Routine-Auswahl „Neue Routine anlegen" mit dem eingegebenen Namen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await openRoutineDraft(page, 'Meditation');

  await expect(newRoutineOption(page, 'Meditation')).toBeVisible();
});

test('AK3: „Neue Routine anlegen" + „Anlegen" legt genau eine habits-Mutation an, Sheet schließt auf /uebersicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await openRoutineDraft(page, 'Meditation');
  await newRoutineOption(page, 'Meditation').click();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.filter((entry) => entry.table === 'habits');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({
    name: 'Meditation',
    schedule: 'daily',
    target: 1,
    color: null,
    archivedAt: null,
  });
});

test('AK4: der Name der neuen Routine ist vor dem Anlegen über den Titel-Chip editierbar', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await openRoutineDraft(page, 'Meditation');
  await newRoutineOption(page, 'Meditation').click();

  await page.getByRole('button', { name: 'Titel, Meditation' }).click();
  await page.getByRole('textbox', { name: 'Titel', exact: true }).fill('Meditation abends');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'habits');
  expect(created?.payload).toMatchObject({ name: 'Meditation abends' });
});

test('AK5: die neu angelegte Routine erscheint auf /routinen und in der Routinen-Sektion der Übersicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await openRoutineDraft(page, 'Meditation');
  await newRoutineOption(page, 'Meditation').click();
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(captureDialog(page)).toBeHidden();

  await expect(
    page.getByRole('checkbox', { name: 'Meditation für heute abhaken' }),
  ).toBeVisible();

  await page.goto('/routinen');
  await expect(
    page.getByRole('list', { name: 'Routinen', exact: true }).getByText('Meditation'),
  ).toBeVisible();
});

test('AK6a (Regression): ein eindeutiger Habit-Treffer hakt weiterhin ab, statt eine neue Routine anzulegen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, 'Sport');
  await page.goto('/uebersicht');

  // Sync ist für dieses Spec-File abgeklemmt (beforeEach) — die seedHabit-Mutation
  // selbst steht also noch in der Outbox. Der Beweis ist deshalb ein Delta: keine
  // ZUSÄTZLICHE habits-Mutation durch "Anlegen", nicht "keine überhaupt".
  const seededHabits = (await page.evaluate(() => window.__starship.pending())).filter(
    (entry) => entry.table === 'habits',
  ).length;

  await captureButton(page).click();
  await captureTitleField(page).fill('hake Sport ab');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Sport für heute abhaken' })).toBeChecked();
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.filter((entry) => entry.table === 'habits')).toHaveLength(seededHabits);
});

test('AK6b (Regression #687): ein Erledigungsverb ohne Habit-Treffer legt weiterhin nichts an', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('hake Meditation ab');

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeVisible();
  await expect(page.getByText('Keiner Gewohnheit zugeordnet.')).toBeVisible();
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries).toHaveLength(0);
});

test('AK7 (Offline): Anlegen offline liegt in der Outbox, online erreicht die neue Routine die Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/uebersicht');
  await context.setOffline(true);

  await openRoutineDraft(page, 'Offline-Routine');
  await newRoutineOption(page, 'Offline-Routine').click();
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach kappt die Sync-Endpunkte — hier lösen, damit die gequeuete Mutation
  // tatsächlich Postgres erreicht. Vor `setOffline(false)`, sonst rennt der
  // automatische online-Sync gegen das Abklemmen der Route (issue #120-Muster,
  // siehe habits.spec.ts).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT name, schedule, target FROM habits WHERE name = $1', [
      'Offline-Routine',
    ]),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].schedule).toBe('daily');
  expect(row.rows[0].target).toBe(1);
});

/**
 * issue #780: derselbe "Neue Routine anlegen"-Zweig, jetzt automatisch über den
 * Erkenner (`routineIntent`-Signal in local-recognizer.ts) statt nur über den
 * Art-Chip von Hand (#758, Tests oben) — ein Test je AK1–AK6 des Tickets.
 */

function newRoutineChip(page: Page, name: string) {
  return page.getByRole('button', { name: `Routine, Neu: „${name}"` });
}

test('#780 AK3/AK4: "Routine Wasser trinken" wird ohne Handwechsel als neue Routine erkannt, der Name trägt das Intent-Wort nicht', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Wasser trinken');

  await expect(artChip(page, 'Routine')).toBeVisible();
  await expect(newRoutineChip(page, 'Wasser trinken')).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.filter((entry) => entry.table === 'habits');
  expect(created).toHaveLength(1);
  expect(created[0].payload).toMatchObject({
    name: 'Wasser trinken',
    schedule: 'daily',
    target: 1,
  });
});

test('#780 AK3: "Gewohnheit …" und "neue Routine …" erkennen ebenso automatisch eine neue Routine', async ({
  page,
}) => {
  await page.goto('/uebersicht');

  for (const { text, name } of [
    { text: 'Gewohnheit meditieren', name: 'meditieren' },
    { text: 'neue Routine Wasser trinken', name: 'Wasser trinken' },
  ]) {
    await captureButton(page).click();
    await captureTitleField(page).fill(text);
    await expect(artChip(page, 'Routine')).toBeVisible();
    await expect(newRoutineChip(page, name)).toBeVisible();
    await page.getByRole('button', { name: 'Abbrechen' }).click();
  }
});

test('#780 AK5: "Routine Sport abgehakt" hakt die bestehende Gewohnheit ab, statt eine zweite anzulegen', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await seedHabit(page, 'Sport');
  await page.goto('/uebersicht');

  // Sync ist für dieses Spec-File abgeklemmt (beforeEach) — die seedHabit-Mutation
  // selbst steht also noch in der Outbox, derselbe Delta-Beweis wie AK6a oben.
  const seededHabits = (await page.evaluate(() => window.__starship.pending())).filter(
    (entry) => entry.table === 'habits',
  ).length;

  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Sport abgehakt');
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Sport für heute abhaken' })).toBeChecked();
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries.filter((entry) => entry.table === 'habits')).toHaveLength(seededHabits);
});

test('#780 AK5: "Routine Meditation abgehakt" ohne vorhandene Gewohnheit legt weiterhin nichts an (#687 AK6)', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Meditation abgehakt');

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeVisible();
  await expect(page.getByText('Keiner Gewohnheit zugeordnet.')).toBeVisible();
  const entries = await page.evaluate(() => window.__starship.pending());
  expect(entries).toHaveLength(0);
});

test('#780 AK6: Routinen-Modul aus -> "Routine Wasser trinken" bleibt eine Aufgabe', async ({
  page,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(() =>
    localStorage.setItem('starship:modules-off', JSON.stringify(['routinen'])),
  );
  await page.goto('/uebersicht');

  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Wasser trinken');
  await expect(artChip(page, 'Aufgabe')).toBeVisible();

  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  const entries = await page.evaluate(() => window.__starship.pending());
  const created = entries.find((entry) => entry.table === 'tasks');
  // Das Intent-Wort bleibt im Titel stehen: außerhalb des `newHabit`-Zweigs gibt
  // es keine Titel-Bereinigung (R3 aus #687).
  expect(created?.payload).toMatchObject({ title: 'Routine Wasser trinken' });
});

test('#780 Offline: eine automatisch erkannte neue Routine liegt offline in der Outbox, online erreicht sie die Datenbank', async ({
  page,
  context,
}) => {
  await page.goto('/uebersicht');
  await context.setOffline(true);

  await captureButton(page).click();
  await captureTitleField(page).fill('Routine Kaltduschen');
  await expect(newRoutineChip(page, 'Kaltduschen')).toBeVisible();
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(captureDialog(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // beforeEach kappt die Sync-Endpunkte — hier lösen, damit die gequeuete Mutation
  // tatsächlich Postgres erreicht. Vor `setOffline(false)`, sonst rennt der
  // automatische online-Sync gegen das Abklemmen der Route (issue #120-Muster).
  await page.unroute('**/api/sync/**');
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT name, schedule, target FROM habits WHERE name = $1', ['Kaltduschen']),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].schedule).toBe('daily');
  expect(row.rows[0].target).toBe(1);
});
