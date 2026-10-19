import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  createOtherAccount,
  createThrowawaySession,
  currentAccountId,
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

/** A second, independent browser context signed in as a `role: 'user'` account
 * — never the shared `AUTH_STATE` session, which is always the admin one. */
async function nonAdminContext(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const other = await createOtherAccount('Nutzerkonto');
  const session = await createThrowawaySession(undefined, undefined, other.userId);
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

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

  // #1234 AK5: weder ein gesäter Push-Endpunkt/User-Agent noch ein code_hash
  // dürfen in der Antwort vorkommen.
  const markedEndpoint = `https://push.example/${randomUUID()}`;
  const markedUserAgent = `Marker-UA-${randomUUID()}`;
  const markedCodeHash = `marker-hash-${randomUUID()}`;
  await withDb((client) =>
    client.query(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), other.userId, markedEndpoint, 'p256dh', 'auth', markedUserAgent],
    ),
  );
  await withDb((client) =>
    client.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)', [
      randomUUID(),
      other.userId,
      markedCodeHash,
    ]),
  );

  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const raw = JSON.stringify(body);

  // AK8: kein Nutzerinhalt — weder Titel noch Journal-„Chiffrat".
  for (const value of Object.values(other.titles)) {
    expect(raw).not.toContain(value);
  }

  // #1234 AK5.
  expect(raw).not.toContain(markedEndpoint);
  expect(raw).not.toContain(markedUserAgent);
  expect(raw).not.toContain(markedCodeHash);

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

test('#1234 AK1/AK2/AK3/AK4: Gesundheitswerte je Konto gegen gesäten Bestand', async ({ page }) => {
  const data = await createOtherAccount('Daten-Konto');

  const neverId = randomUUID();
  await withDb((client) =>
    client.query("INSERT INTO users (id, role, display_name) VALUES ($1, 'user', 'Nie-Konto')", [
      neverId,
    ]),
  );

  const usedUpId = randomUUID();
  await withDb(async (client) => {
    await client.query(
      "INSERT INTO users (id, role, display_name) VALUES ($1, 'user', 'Verbraucht-Konto')",
      [usedUpId],
    );
    await client.query(
      `INSERT INTO recovery_codes (id, user_id, code_hash, used_at)
       VALUES ($1, $2, $3, now()), ($4, $2, $5, now())`,
      [randomUUID(), usedUpId, `hash-${randomUUID()}`, randomUUID(), `hash-${randomUUID()}`],
    );
  });

  const pushId = randomUUID();
  await withDb(async (client) => {
    await client.query(
      "INSERT INTO users (id, role, display_name) VALUES ($1, 'user', 'Push-Konto')",
      [pushId],
    );
    await client.query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, 'https://push.example/push-a', 'p', 'a'),
              ($3, $2, 'https://push.example/push-b', 'p', 'a')`,
      [randomUUID(), pushId, randomUUID()],
    );
    // Außerhalb des 30-Tage-Fensters — darf nicht mitzählen.
    await client.query(
      `INSERT INTO reminder_sends (id, user_id, kind, send_date, slot, sent_at)
       VALUES ($1, $2, 'tasks-due', current_date - 31, 'morning', now() - interval '31 days')`,
      [randomUUID(), pushId],
    );
    // Innerhalb des Fensters — Gegenprobe.
    await client.query(
      `INSERT INTO reminder_sends (id, user_id, kind, send_date, slot, sent_at)
       VALUES ($1, $2, 'tasks-due', current_date, 'morning', now())`,
      [randomUUID(), pushId],
    );
  });

  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const accounts: Array<{
    id: string;
    lastSyncAt: string | null;
    recovery: { unused: number; total: number };
    push: { subscriptions: number; reminders30: number };
  }> = body.accounts;

  // AK1: Daten-Konto hat einen gesetzten letzten Sync, das „nie"-Konto keinen.
  const dataRow = accounts.find((account) => account.id === data.userId);
  expect(dataRow?.lastSyncAt).toBeTruthy();

  const neverRow = accounts.find((account) => account.id === neverId);
  expect(neverRow?.lastSyncAt).toBeNull();
  // AK2: „keine erzeugt".
  expect(neverRow?.recovery).toEqual({ unused: 0, total: 0 });

  // AK2: „alle verbraucht".
  const usedUpRow = accounts.find((account) => account.id === usedUpId);
  expect(usedUpRow?.recovery).toEqual({ unused: 0, total: 2 });

  // AK3: zwei Abos, nur die 30-Tage-Erinnerung zählt.
  const pushRow = accounts.find((account) => account.id === pushId);
  expect(pushRow?.push).toEqual({ subscriptions: 2, reminders30: 1 });
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
