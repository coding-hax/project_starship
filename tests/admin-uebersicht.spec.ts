import { expect, test } from '@playwright/test';
import {
  createOtherAccount,
  currentAccountId,
  nonAdminContext,
  registerPasskey,
  resetAppData,
  seedInvite,
  withDb,
} from './helpers';

/**
 * S4 of #1199 (#1203) — Admin-Übersicht, nur lesend. E2E nur für K1-K5
 * (ADR-0032); AK9 (Mobile/Dark Mode/reduced-motion) ist D1/D2, prüft der
 * Mensch am Gerät.
 */

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page, null);
});

test.describe('AK1: /admin und /api/admin/* nur mit role=admin', () => {
  test('Admin lädt /admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Verwaltung', level: 1 })).toBeVisible();
  });

  test('ein angemeldetes Nutzer-Konto bekommt 404 — Seite und API', async ({ browser, baseURL }) => {
    const { page, close } = await nonAdminContext(browser, baseURL);

    const pageResponse = await page.goto('/admin');
    expect(pageResponse?.status()).toBe(404);

    const apiResponse = await page.request.get('/api/admin/accounts');
    expect(apiResponse.status()).toBe(404);

    await close();
  });

  test('eine nicht angemeldete Anfrage landet auf /anmelden — Seite und API', async ({ browser }) => {
    const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anonymous.newPage();

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/anmelden$/);

    const apiResponse = await page.request.get('/api/admin/accounts');
    expect(apiResponse.url()).toMatch(/\/anmelden$/);

    await anonymous.close();
  });
});

test('AK2: die Übersicht zeigt Etikett, Status und die Feld-Labels je Konto', async ({ page }) => {
  await createOtherAccount('Fremdkonto');

  await page.goto('/admin');

  await expect(page.getByText('Fremdkonto')).toBeVisible();
  await expect(page.getByText('eingeladen')).toBeVisible();
  for (const label of ['Angelegt am', 'Zuletzt aktiv', 'Aktive Tage (30)', 'Speicher', 'Geräte', 'Sitzungen']) {
    await expect(page.getByText(label).first()).toBeVisible();
  }
});

test('AK4/AK5/AK6/AK7/AK8: echte Zahlen je Konto, offene Einladungen, kein Nutzerinhalt leckt', async ({
  page,
}) => {
  const adminId = await currentAccountId();
  const other = await createOtherAccount('Fremdkonto');

  await seedInvite({ createdBy: adminId, label: 'Offene-Einladung' });
  await seedInvite({ createdBy: adminId, label: 'Verbrauchte-Einladung' });
  await withDb((client) =>
    client.query("UPDATE invites SET used_at = now() WHERE label = 'Verbrauchte-Einladung'"),
  );

  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const raw = JSON.stringify(body);

  // AK8: kein Nutzerinhalt — weder Titel noch Journal-„Chiffrat".
  for (const value of Object.values(other.titles)) {
    expect(raw).not.toContain(value);
  }

  // AK4/AK5: echte Zeilen-/Byte-Zahlen je Modul für das gesäte Konto.
  const otherRow = body.accounts.find((account: { id: string }) => account.id === other.userId);
  expect(otherRow).toBeTruthy();
  expect(otherRow.modules.aufgaben.rows).toBe(1);
  expect(otherRow.modules.aufgaben.bytes).toBeGreaterThan(0);
  expect(otherRow.modules.termine.rows).toBe(2);
  expect(otherRow.modules.routinen.rows).toBe(2);
  expect(otherRow.modules.journal.rows).toBe(2);
  expect(otherRow.bytes).toBeGreaterThan(0);

  // AK6: Kopf-Summen plausibel gegen den gesäten Bestand.
  expect(body.summary.totalAccounts).toBeGreaterThanOrEqual(2);
  expect(body.summary.openInvites).toBeGreaterThanOrEqual(1);
  expect(body.summary.totalBytes).toBeGreaterThan(0);

  // AK7: die offene Einladung steht drin, die verbrauchte nicht.
  const invites: Array<{ label: string | null; expiresAt: string }> = body.invites;
  const open = invites.find((invite) => invite.label === 'Offene-Einladung');
  expect(open).toBeTruthy();
  expect(open?.expiresAt).toBeTruthy();
  expect(invites.find((invite) => invite.label === 'Verbrauchte-Einladung')).toBeUndefined();
});

test.describe('AK10: Einstellungs-Eintrag „Verwaltung" nur für role=admin', () => {
  test('Admin sieht die Gruppe mit Link auf /admin', async ({ page }) => {
    await page.goto('/einstellungen');

    await expect(page.getByRole('heading', { name: 'Verwaltung' })).toBeVisible();
    await page.getByRole('link', { name: 'Admin-Bereich' }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('ein Nutzer-Konto findet die Gruppe nicht im DOM', async ({ browser, baseURL }) => {
    const { page, close } = await nonAdminContext(browser, baseURL);

    await page.goto('/einstellungen');

    await expect(page.getByRole('heading', { name: 'Verwaltung' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Admin-Bereich' })).toHaveCount(0);

    await close();
  });
});
