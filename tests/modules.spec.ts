import { expect, test, type Page } from '@playwright/test';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import {
  expectUebersichtLoaded,
  registerPasskey,
  resetAppData,
  settleJournalHabitBoot,
  withDb,
} from './helpers';

const MODULES_OFF_KEY = 'starship:modules-off';

async function setModulesOff(page: Page, off: string[]): Promise<void> {
  await page.evaluate(
    ({ key, off }) => localStorage.setItem(key, JSON.stringify(off)),
    { key: MODULES_OFF_KEY, off },
  );
}

test.beforeEach(async ({ page }) => {
  await registerPasskey(page);
});

test('Journal aus archiviert die Journal-Routine, wieder an entarchiviert sie (issue #505 AC7)', async ({
  page,
}) => {
  await resetAppData();
  // beforeEach's registerPasskey already loaded /uebersicht once, so
  // JournalHabitBoot's own boot effect may have already created+synced a local
  // Journal-habit row before the resetAppData() wipe above ran — a race
  // against the SQL DELETE that leaves the client believing the row still
  // exists while Postgres just lost it (issue #650 Fund). ensureJournalHabit()
  // below only checks local existence, so a stale local row makes it a no-op
  // and the wiped server row never gets recreated. Clear it through Dexie's
  // own connection first, so the ensure below always starts from a genuinely
  // empty slate.
  await page.evaluate(
    ([table, id]) => window.__starship.debugDeleteRecord(table, id),
    ['habits', JOURNAL_HABIT_ID] as [string, string],
  );
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);

  const before = await withDb((client) =>
    client.query('SELECT id, archived_at FROM habits WHERE name = $1', ['Journal']),
  );
  expect(before.rowCount).toBe(1);
  expect(before.rows[0].archived_at).toBeNull();
  const habitId = before.rows[0].id as string;

  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Journal' }).click();
  // module-panel.tsx fires archiveJournalHabit() fire-and-forget (`void`), never
  // awaited by the click handler — calling sync() right after click() can win the
  // race against that mutation's own `readHabitRow()` + `mutate()` chain and push
  // an empty outbox (issue #650 Fund). Wait for the queued entry to actually land
  // before triggering the push.
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);
  await page.evaluate(() => window.__starship.sync());

  const afterOff = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE id = $1', [habitId]),
  );
  expect(afterOff.rows[0].archived_at).not.toBeNull();

  await page.getByRole('switch', { name: 'Journal' }).click();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);
  await page.evaluate(() => window.__starship.sync());

  const afterOn = await withDb((client) =>
    client.query('SELECT archived_at FROM habits WHERE id = $1', [habitId]),
  );
  expect(afterOn.rows[0].archived_at).toBeNull();
});

test('der Zustand übersteht einen Reload (issue #307 AC5)', async ({ page }) => {
  await page.goto('/einstellungen');
  await page.getByRole('switch', { name: 'Routinen' }).click();
  await expect(page.getByRole('switch', { name: 'Routinen' })).toHaveAttribute('aria-checked', 'false');

  await page.reload();
  await expect(page.getByRole('switch', { name: 'Routinen' })).toHaveAttribute('aria-checked', 'false');
  await expect(
    page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Routinen' }),
  ).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* T3 (issue #309): Route-Guard + Flacker-Schutz für abgeschaltete Module     */
/* -------------------------------------------------------------------------- */

test('Direktaufruf einer Aus-Route landet auf /uebersicht, kein 404 (issue #309 AC1)', async ({ page }) => {
  await setModulesOff(page, ['journal']);

  const response = await page.goto('/journal');

  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expectUebersichtLoaded(page);
  // Titel „Wie war dein Tag?“ seit issue #868.
  await expect(page.getByRole('heading', { name: 'Wie war dein Tag?', level: 1 })).toHaveCount(0);
});
