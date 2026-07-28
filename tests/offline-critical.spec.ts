import { expect, test } from '@playwright/test';
import { registerPasskey, resetAppData, withDb } from './helpers';

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

  // 2. Offline.
  await context.setOffline(true);

  // 3. Task über die echte UI anlegen — der kritische Nutzerpfad, keine Bridge.
  const title = 'Im Tunnel notiert';
  await page.getByRole('button', { name: 'Aufgabe erfassen' }).click();
  await page.getByRole('textbox', { name: 'Titel der Aufgabe' }).fill(title);
  await page.getByRole('button', { name: 'Hinzufügen' }).click();

  await expect(page.getByText(title)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Stärkung: die App-Shell kommt offline weiter — aus dem Precache des Service
  // Workers, nicht vom Netz — und der Task bleibt sichtbar (aus IndexedDB).
  await page.reload();
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
  // /journal muss vor dem Offline-Gehen einmal geladen sein, damit Serwists
  // Laufzeit-Cache eine Antwort dafür bereithält — anders als die /heute-Weiterleitung
  // oben kommt die Umleitung hier nicht aus sw.ts, sondern rein clientseitig aus
  // module-route-guard.tsx (ADR-0012 K1): der Service Worker kennt `starship:modules-off`
  // gar nicht, er muss nur die Seite selbst (samt JS) bedienen können.
  await page.goto('/journal');
  await page.goto('/uebersicht');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await page.evaluate(() => localStorage.setItem('starship:modules-off', JSON.stringify(['journal'])));

  await context.setOffline(true);

  const response = await page.goto('/journal');
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page).toHaveURL(/\/uebersicht$/);
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
});
