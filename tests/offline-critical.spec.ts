import { expect, test } from '@playwright/test';
import {
  FIXED_NOW,
  registerPasskey,
  resetAppData,
  selectView,
  settleJournalHabitBoot,
  skewClock,
  withDb,
} from './helpers';

/**
 * The one spec that proves the full offline round-trip (issue #57): a real service
 * worker, not just a DOM that happens to render. Runs only against the prod-build
 * projects (offline-mobile/offline-desktop, see playwright.config.ts) — the dev
 * server never ships a service worker (next.config.ts: `disable: NODE_ENV ===
 * 'development'`).
 *
 * Unlike tasks.spec.ts, this test does not cut `/api/sync/**` in beforeEach — the
 * whole point is watching the round trip actually reach Postgres.
 */
test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page);
  await page.goto('/aufgaben');
});

test('Service Worker → IndexedDB → Outbox → Postgres im geschlossenen Kreis', async ({
  page,
  context,
}) => {
  // 1. Service Worker aktiv? Nicht nur DOM da — `ready` beweist nur, dass ein Worker
  // aktiv ist, nicht dass DIESE Seite von ihm kontrolliert wird: clientsClaim
  // (src/app/sw.ts) beansprucht bestehende Clients erst nach Abschluss der
  // Aktivierung, was mit der ersten Navigation racen kann. Eine frische Navigation
  // NACH `ready` wird dagegen immer vom bereits aktiven Worker bedient — deterministisch,
  // kein längeres Warten auf dasselbe Rennen.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  // The reload above resets the (unpersisted, issue #705) view back to its
  // "Woche" default — the undated task this test seeds below only shows in "Alle".
  await selectView(page, 'Alle');

  // 2. Offline.
  await context.setOffline(true);

  // 3. Task über die echte UI anlegen — der kritische Nutzerpfad, keine Bridge.
  const title = 'Im Tunnel notiert';
  await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
  await page.getByRole('textbox', { name: 'Titel der Aufgabe' }).fill(title);
  await page.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page.getByText(title)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Stärkung: die App-Shell kommt offline weiter — aus dem Precache des Service
  // Workers, nicht vom Netz — und der Task bleibt sichtbar (aus IndexedDB).
  await page.reload();
  await selectView(page, 'Alle');
  await expect(page.getByText(title)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // 4. Online.
  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());

  // 5. Landet der Eintrag in Postgres? Outbox leer?
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const row = await withDb((client) =>
    client.query('SELECT title FROM tasks WHERE title = $1', [title]),
  );
  expect(row.rows).toHaveLength(1);
});

test('ein bereits installiertes /heute (start_url, offener Tab) leitet auch offline aus dem Service Worker auf /uebersicht um (issue #161)', async ({
  page,
  context,
}) => {
  // /uebersicht muss vor dem Offline-Gehen einmal geladen sein, damit Serwists
  // Laufzeit-Cache eine Antwort für die Weiterleitung bereithält — die Weiterleitung
  // selbst kommt aus sw.ts, nicht vom (offline nicht erreichbaren) Server.
  await page.goto('/uebersicht');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);

  const response = await page.goto('/heute');
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
});

test('ein direkter Aufruf einer Aus-Route leitet auch offline aus dem Service-Worker-Cache um, weil der Guard clientseitig ist (issue #309 AC2)', async ({
  page,
  context,
}) => {
  await page.goto('/uebersicht');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // /journal muss NACH bestätigter SW-Kontrolle einmal geladen werden, damit Serwists
  // Laufzeit-Cache eine Antwort dafür bereithält — jede Response davor (SW kontrolliert
  // die Seite noch nicht) landet nicht im Cache. Anders als die /heute-Weiterleitung oben
  // kommt die Umleitung hier nicht aus sw.ts, sondern rein clientseitig aus
  // module-route-guard.tsx (ADR-0012 K1): der Service Worker kennt `starship:modules-off`
  // gar nicht, er muss nur die Seite selbst (samt JS) bedienen können.
  await page.goto('/journal');

  await page.evaluate(() =>
    localStorage.setItem('starship:modules-off', JSON.stringify(['journal'])),
  );

  await context.setOffline(true);

  const response = await page.goto('/journal');
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* issue #505 AC8: offline geänderter Rhythmus UND ein offline geschriebener  */
/* Eintrag der Journal-Routine (Auto-Log) erreichen zusammen die Datenbank */
/* -------------------------------------------------------------------------- */

test('offline geänderter Rhythmus und ein offline geschriebener Eintrag der Journal-Routine erreichen zusammen die Datenbank (issue #505 AC8)', async ({
  page,
  context,
}) => {
  const passphrase = 'ac8 offline passphrase';

  // Fixed clock, same pattern as habits-uebersicht.spec.ts — beforeEach's
  // registerPasskey already navigated, so install() (which needs to run before the
  // first navigation) is not an option; setFixedTime() has no such restriction and
  // survives the reload below. Needed so entryDate below can't straddle a real
  // midnight during the test (#495).
  await skewClock(page, FIXED_NOW);

  // Passphrase-Einrichtung über die Bridge, nicht die /journal-UI: jede Navigation
  // dorthin lädt einen RSC-Payload, den Serwists Laufzeit-Cache nur unter dem
  // jeweils aktuellen `_rsc`-Query-Hash ablegt — der ändert sich bei jedem Besuch,
  // ein späterer Offline-Aufruf trifft also nie denselben Cache-Eintrag (anders als
  // die reinen Dokument-Navigationen der beiden Tests oben, denen ein einzelner,
  // stabiler Pfad genügt). journalSetup() ist derselbe Aufruf, den das Formular
  // selbst macht (lock-store.ts), nur ohne den fragilen Navigationspfad.
  await page.evaluate((p) => window.__starship.journalSetup(p), passphrase);

  await page.goto('/routinen');
  const journalHabit = page
    .getByRole('list', { name: 'Routinen', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Journal' });
  await expect(journalHabit).toBeVisible();
  // Settle it (issue #505 AC1) before going offline — JournalHabitBoot enqueues its
  // create mutation asynchronously after its own boot sync, with no bound on when;
  // left unsettled it can still be sitting in the outbox once offline, inflating the
  // size() count the rhythm-change/entry actions below expect to own exclusively.
  await settleJournalHabitBoot(page);

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);

  // The reload wiped the in-memory DEK (lock-store.ts's `dek` is a module
  // variable) — restoring it normally needs journal-gate.tsx to mount (its
  // `useJournalLock` effect is what calls `ensureInitialized`), which only
  // happens on /journal, not here. journalUnlock() re-derives it directly from
  // the already-pulled local envelope (readEnvelope, pure IndexedDB) — no
  // component mount and no network needed, so it works offline too.
  await page.evaluate((p) => window.__starship.journalUnlock(p), passphrase);

  // Rhythmus offline wechseln — bleibt auf /routinen, dessen Cache der Reload
  // oben bereits bestätigt hat (kein zweiter fragiler Navigationspfad nötig).
  await journalHabit.getByRole('button', { name: /^Journal\b/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Routine bearbeiten' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Wöchentlich' }).check();
  await dialog.getByRole('button', { name: 'Sichern' }).click();
  await expect(dialog).toBeHidden();

  // Eintrag über die Bridge (appendJournalEntry, derselbe Aufruf wie der echte
  // Editor-Submit, inkl. Auto-Log AC4) statt einer Navigation zu /journal — aus
  // demselben Grund wie journalSetup oben.
  const entryText = 'Offline im Tunnel geschrieben';
  await page.evaluate(
    ({ iso, text }) =>
      window.__starship.appendJournalEntry(new Date(iso).toLocaleDateString('en-CA'), { text }),
    { iso: FIXED_NOW, text: entryText },
  );
  // Rhythmuswechsel (habits) + Eintrag (journal_entries) + Auto-Log (habit_logs).
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(3);

  await context.setOffline(false);
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const entryDate = await page.evaluate(
    (iso) => new Date(iso).toLocaleDateString('en-CA'),
    FIXED_NOW,
  );
  const row = await withDb((client) =>
    client.query(
      `SELECT h.schedule, hl.done FROM habits h
       JOIN habit_logs hl ON hl.habit_id = h.id
       WHERE h.name = 'Journal' AND hl.log_date = $1 AND hl.deleted_at IS NULL`,
      [entryDate],
    ),
  );
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].schedule).toBe('weekly');
  expect(row.rows[0].done).toBe(true);
});
