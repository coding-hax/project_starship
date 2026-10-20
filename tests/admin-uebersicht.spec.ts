import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  createOtherAccount,
  createThrowawaySession,
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

/** Same as `nonAdminContext`, but also hands back the account id (#1235) — the
 * sync-counter specs below need it to query their own account's row back out
 * of `/api/admin/accounts` and to seed/assert straight against the DB. */
async function freshAccountContext(
  browser: Browser,
  baseURL: string | undefined,
  label: string,
): Promise<{ userId: string; page: Page; close: () => Promise<void> }> {
  const account = await createOtherAccount(label);
  const session = await createThrowawaySession(undefined, undefined, account.userId);
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();
  return { userId: account.userId, page, close: () => context.close() };
}

function upsertMutation(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    table: 'tasks',
    rowId: randomUUID(),
    op: 'upsert',
    payload: { title: 'Sync-Zaehler-Test' },
    updatedAt: '2026-07-20T12:00:00.000Z',
    baseSeq: null,
    ...overrides,
  };
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
  for (const label of [
    'Angelegt am',
    'Zuletzt aktiv',
    'Aktive Tage (30)',
    'Wachzeit 30 T',
    'Speicher',
    'Geräte',
    'Sitzungen',
  ]) {
    await expect(page.getByText(label).first()).toBeVisible();
  }
});

test('#1233 AK1: eine Anfrage durch requireUser() vermerkt das 5-Minuten-Fenster fürs eigene Konto', async ({
  page,
}) => {
  const adminId = await currentAccountId();

  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);
  const body = await response.json();

  const adminRow = body.accounts.find((account: { id: string }) => account.id === adminId);
  expect(adminRow).toBeTruthy();
  expect(adminRow.wakeMinutes30).toBeGreaterThan(0);
});

test('#1233 AK3: GET /api/health und der Cron-Pfad von POST /api/push/reminders zählen als eigene Systemquellen', async ({
  page,
}) => {
  const healthResponse = await page.request.get('/api/health');
  expect(healthResponse.ok()).toBe(true);

  const cronResponse = await page.request.post('/api/push/reminders', {
    headers: { Authorization: 'Bearer e2e-throwaway-reminder-secret' },
  });
  expect(cronResponse.ok()).toBe(true);

  const response = await page.request.get('/api/admin/accounts');
  const body = await response.json();

  expect(body.summary.wake.deployProbeMinutes).toBeGreaterThan(0);
  expect(body.summary.wake.cronMinutes).toBeGreaterThan(0);
});

test('#1233 AK4/AK5: Wachzeit-Regel — ein Fenster teilt 5 Minuten zu gleichen Teilen auf seine Quellen auf', async ({
  page,
}) => {
  const solo = await createOtherAccount('Solo-Konto');
  const pairA = await createOtherAccount('Paar-Konto-A');
  const pairB = await createOtherAccount('Paar-Konto-B');
  const withCron = await createOtherAccount('Cron-Konto');

  // Weit genug in der Vergangenheit (aber innerhalb der 30-Tage-Anzeige), damit
  // keine im selben Lauf live vermerkte Anfrage in dasselbe Fenster fällt.
  await withDb((client) =>
    client.query(
      `INSERT INTO user_activity_windows (user_id, system_source, window_start) VALUES
         ($1, NULL, date_trunc('hour', now()) - interval '10 days'),
         ($2, NULL, date_trunc('hour', now()) - interval '11 days'),
         ($3, NULL, date_trunc('hour', now()) - interval '11 days'),
         ($4, NULL, date_trunc('hour', now()) - interval '12 days'),
         (NULL, 'cron', date_trunc('hour', now()) - interval '12 days')`,
      [solo.userId, pairA.userId, pairB.userId, withCron.userId],
    ),
  );

  const response = await page.request.get('/api/admin/accounts');
  const body = await response.json();
  const accounts: Array<{ id: string; wakeMinutes30: number; wakeShare: number }> = body.accounts;
  const row = (userId: string) => accounts.find((account) => account.id === userId);

  // Ein Konto allein in einem Fenster: 5 min.
  expect(row(solo.userId)?.wakeMinutes30).toBe(5);
  // Zwei Konten im selben Fenster: je 2,5 min.
  expect(row(pairA.userId)?.wakeMinutes30).toBe(2.5);
  expect(row(pairB.userId)?.wakeMinutes30).toBe(2.5);
  // Ein Konto und `cron` im selben Fenster: je 2,5 min.
  expect(row(withCron.userId)?.wakeMinutes30).toBe(2.5);

  // AK5: der Anteil ist der rechnerisch korrekte, nicht nur ein Platzhalter.
  const total = body.summary.wake.totalMinutes;
  for (const account of [solo, pairA, pairB, withCron]) {
    const r = row(account.userId);
    expect(r?.wakeShare).toBeCloseTo((r!.wakeMinutes30 / total) * 100, 5);
  }

  // AK4: „Die Summe aller Anteile ist genau die Gesamtwachzeit" — gilt für
  // jede Kontoreihe plus die Systemquellen, unabhängig von sonstigen,
  // zeitgleich im Lauf vermerkten Fenstern.
  const accountSum = accounts.reduce((sum: number, account) => sum + account.wakeMinutes30, 0);
  expect(accountSum + body.summary.wake.cronMinutes + body.summary.wake.deployProbeMinutes).toBeCloseTo(
    total,
    5,
  );
});

test('#1233 AK7: Wachzeitfenster verlassen /api/admin/* nie als einzelne Zeitpunkte', async ({ page }) => {
  const other = await createOtherAccount('Zeitstempel-Konto');
  const markedWindowStart = new Date(Date.UTC(2026, 0, 1, 10, 5, 0));
  await withDb((client) =>
    client.query('INSERT INTO user_activity_windows (user_id, window_start) VALUES ($1, $2)', [
      other.userId,
      markedWindowStart,
    ]),
  );

  const response = await page.request.get('/api/admin/accounts');
  const raw = JSON.stringify(await response.json());

  expect(raw).not.toContain(markedWindowStart.toISOString());
  expect(raw).not.toContain('2026-01-01T10:05');
});

test('#1233 AK8: Fenster älter als 31 Tage werden gelöscht, 30 Tage alte bleiben', async ({ page }) => {
  const old = await createOtherAccount('Altes-Fenster-Konto');
  const recent = await createOtherAccount('Junges-Fenster-Konto');

  await withDb((client) =>
    client.query(
      `INSERT INTO user_activity_windows (user_id, window_start) VALUES
         ($1, date_trunc('hour', now()) - interval '32 days'),
         ($2, date_trunc('hour', now()) - interval '30 days')`,
      [old.userId, recent.userId],
    ),
  );

  // Jede Anfrage durch requireUser() prunt mit (recordActivityWindow).
  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);

  const rows = await withDb((client) =>
    client.query('SELECT user_id FROM user_activity_windows WHERE user_id = ANY($1)', [
      [old.userId, recent.userId],
    ]),
  );
  const remainingIds = rows.rows.map((row: { user_id: string }) => row.user_id);

  expect(remainingIds).not.toContain(old.userId);
  expect(remainingIds).toContain(recent.userId);
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

  // #1235 AK8: eine einzelne Sitzung mit einer individuellen Build-Kennung darf
  // nicht als Rohwert erscheinen — nur die aggregierte `staleDevices`-Zahl.
  const markedAppVersion = `marker-build-${randomUUID()}`;
  await withDb((client) =>
    client.query(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, app_version) VALUES ($1, $2, $3, now() + interval \'1 day\', $4)',
      [randomUUID(), other.userId, `marker-hash-${randomUUID()}`, markedAppVersion],
    ),
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

  // #1235 AK8.
  expect(raw).not.toContain(markedAppVersion);

  // AK4/AK5: echte Zeilen-/Byte-Zahlen je Modul für das gesäte Konto.
  const otherRow = body.accounts.find((account: { id: string }) => account.id === other.userId);
  expect(otherRow).toBeTruthy();
  // #1235 AK4: die eine gesäte Sitzung mit abweichender Build-Kennung zählt.
  expect(otherRow.staleDevices).toBe(1);
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

test('#1235 AK1: Ablehnungen (malformed/missing-required/constraint/quota) und Konflikte zählen je Konto', async ({
  page,
  browser,
  baseURL,
}) => {
  const account = await freshAccountContext(browser, baseURL, 'Zaehler-Konto');

  const malformed = {
    id: randomUUID(),
    table: 'garmin_activities',
    rowId: randomUUID(),
    op: 'upsert',
    payload: {},
    updatedAt: '2026-07-20T12:00:00.000Z',
    baseSeq: null,
  };
  const missingRequired = upsertMutation({ payload: {} });
  const constraintViolation = upsertMutation({
    table: 'habit_logs',
    payload: { habitId: randomUUID(), logDate: '2026-07-20', done: false },
  });
  const createRowId = randomUUID();
  const create = upsertMutation({ rowId: createRowId });
  // `baseSeq: 0` is below any real `sync_seq` (starts at 1) — guaranteed stale
  // against the row `create` above just applied in the same transaction.
  const conflicting = upsertMutation({ rowId: createRowId, baseSeq: 0 });

  const push = await account.page.request.post('/api/sync/push', {
    data: { mutations: [malformed, missingRequired, constraintViolation, create, conflicting] },
  });
  expect(push.ok()).toBe(true);
  const pushBody = await push.json();
  expect(pushBody.rejected).toHaveLength(3);
  expect(pushBody.conflicts).toHaveLength(1);

  // #1205 AC6: eine Charge mit einer Nicht-delete-Mutation über dem Limit wird
  // als `quota` gezählt, nicht unter den drei Ablehnungsgründen oben.
  await withDb((client) =>
    client.query('UPDATE users SET storage_limit_bytes = 1 WHERE id = $1', [account.userId]),
  );
  const overQuota = await account.page.request.post('/api/sync/push', {
    data: { mutations: [upsertMutation()] },
  });
  expect(overQuota.status()).toBe(413);

  const response = await page.request.get('/api/admin/accounts');
  const body = await response.json();
  const row = body.accounts.find((a: { id: string }) => a.id === account.userId);

  expect(row.sync.rejections).toEqual({ malformed: 1, missingRequired: 1, constraint: 1, quota: 1 });
  expect(row.sync.conflicts).toBe(1);

  await account.close();
});

test('#1235 AK2: ein Pull mit since=0 zählt als Vollpull, since>0 nicht', async ({
  page,
  browser,
  baseURL,
}) => {
  const account = await freshAccountContext(browser, baseURL, 'Vollpull-Konto');

  const full = await account.page.request.get('/api/sync/pull?since=0');
  expect(full.ok()).toBe(true);

  const response = await page.request.get('/api/admin/accounts');
  const body = await response.json();
  const row = body.accounts.find((a: { id: string }) => a.id === account.userId);
  expect(row.sync.fullPulls).toBe(1);

  // Gegenprobe: ein Pull mit since>0 zählt nicht noch einmal mit.
  const partial = await account.page.request.get('/api/sync/pull?since=1');
  expect(partial.ok()).toBe(true);

  const response2 = await page.request.get('/api/admin/accounts');
  const body2 = await response2.json();
  const row2 = body2.accounts.find((a: { id: string }) => a.id === account.userId);
  expect(row2.sync.fullPulls).toBe(1);

  await account.close();
});

test('#1235 AK4: App-Stand je Sitzung — nur ein nicht-leerer Header schreibt', async ({ browser, baseURL }) => {
  const account = await freshAccountContext(browser, baseURL, 'App-Stand-Konto');

  await account.page.request.post('/api/sync/push', {
    headers: { 'x-app-version': 'build-x' },
    data: { mutations: [] },
  });
  const afterFirst = await withDb((client) =>
    client.query('SELECT app_version FROM sessions WHERE user_id = $1', [account.userId]),
  );
  expect(afterFirst.rows[0].app_version).toBe('build-x');

  // Kein Header (leer) ist ein No-Op — löscht den zuvor gemeldeten Stand nicht.
  await account.page.request.post('/api/sync/push', { data: { mutations: [] } });
  const afterSecond = await withDb((client) =>
    client.query('SELECT app_version FROM sessions WHERE user_id = $1', [account.userId]),
  );
  expect(afterSecond.rows[0].app_version).toBe('build-x');

  await account.close();
});

test('#1235 AK5: ein sauberer Push und ein since>0-Pull schreiben keine Zählerzeile', async ({
  browser,
  baseURL,
}) => {
  const account = await freshAccountContext(browser, baseURL, 'Sauber-Konto');

  const clean = await account.page.request.post('/api/sync/push', {
    data: { mutations: [upsertMutation()] },
  });
  expect(clean.ok()).toBe(true);
  const cleanBody = await clean.json();
  expect(cleanBody.rejected).toEqual([]);
  expect(cleanBody.conflicts).toEqual([]);

  const partialPull = await account.page.request.get('/api/sync/pull?since=1');
  expect(partialPull.ok()).toBe(true);

  const rows = await withDb((client) =>
    client.query('SELECT 1 FROM account_sync_counters WHERE user_id = $1', [account.userId]),
  );
  expect(rows.rows).toEqual([]);

  await account.close();
});

test('#1235 AK7: 30-Tage-Summen je Konto aus gesäten Zählern, ein 31 Tage alter Tag zählt nicht mit', async ({
  page,
  browser,
  baseURL,
}) => {
  const first = await freshAccountContext(browser, baseURL, 'Summen-Konto-A');
  const second = await freshAccountContext(browser, baseURL, 'Summen-Konto-B');

  await withDb((client) =>
    client.query(
      `INSERT INTO account_sync_counters
         (user_id, day, rejected_malformed, conflicts, full_pulls, push_subscriptions_dropped)
       VALUES
         ($1, current_date, 2, 1, 3, 0),
         ($1, current_date - 5, 1, 0, 0, 0),
         ($1, current_date - 31, 100, 100, 100, 100),
         ($2, current_date - 2, 0, 0, 0, 4)`,
      [first.userId, second.userId],
    ),
  );

  const response = await page.request.get('/api/admin/accounts');
  const body = await response.json();
  const rowA = body.accounts.find((a: { id: string }) => a.id === first.userId);
  const rowB = body.accounts.find((a: { id: string }) => a.id === second.userId);

  expect(rowA.sync.rejections.malformed).toBe(3);
  expect(rowA.sync.conflicts).toBe(1);
  expect(rowA.sync.fullPulls).toBe(3);
  expect(rowB.sync.pushDropped).toBe(4);

  await first.close();
  await second.close();
});

test('#1235 AK9: Zählerzeilen älter als 31 Tage werden beim nächsten Schreibpfad gelöscht', async ({
  browser,
  baseURL,
}) => {
  const old = await freshAccountContext(browser, baseURL, 'Altes-Zaehler-Konto');
  const recent = await freshAccountContext(browser, baseURL, 'Junges-Zaehler-Konto');

  await withDb((client) =>
    client.query(
      `INSERT INTO account_sync_counters (user_id, day, rejected_malformed) VALUES
         ($1, current_date - 32, 1),
         ($2, current_date - 30, 1)`,
      [old.userId, recent.userId],
    ),
  );

  // Jeder Push, der etwas zu zählen hat, prunt mit (`recordSyncCounters`).
  const malformed = {
    id: randomUUID(),
    table: 'garmin_activities',
    rowId: randomUUID(),
    op: 'upsert',
    payload: {},
    updatedAt: '2026-07-20T12:00:00.000Z',
    baseSeq: null,
  };
  const triggering = await old.page.request.post('/api/sync/push', { data: { mutations: [malformed] } });
  expect(triggering.ok()).toBe(true);

  const rows = await withDb((client) =>
    client.query('SELECT user_id, day FROM account_sync_counters WHERE user_id = ANY($1)', [
      [old.userId, recent.userId],
    ]),
  );
  const remainingForOld = rows.rows.filter((r: { user_id: string }) => r.user_id === old.userId);
  expect(remainingForOld.some((r: { day: Date }) => new Date(r.day) < new Date(Date.now() - 31 * 86_400_000))).toBe(
    false,
  );
  expect(rows.rows.some((r: { user_id: string }) => r.user_id === recent.userId)).toBe(true);

  await old.close();
  await recent.close();
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
