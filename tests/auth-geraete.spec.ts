import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import type { Client } from 'pg';
import {
  createThrowawayCredential,
  createThrowawaySession,
  credentialRowExists,
  enableVirtualAuthenticator,
  registerPasskey,
  resetAppData,
  resetRateLimits,
  sessionRowExists,
  withDb,
} from './helpers';

test.beforeEach(async () => {
  await resetAppData();
});

/**
 * A fresh context with its own throwaway `sessions` row (mirrors auth-sperren.spec.ts),
 * never the shared `AUTH_STATE` session every other project's `storageState` depends on —
 * these tests revoke passkeys and end sessions, both destructive.
 */
async function freshSessionContext(browser: Browser, baseURL: string | undefined) {
  const session = await createThrowawaySession();
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();
  return { context, page, tokenHash: session.tokenHash };
}

/**
 * Same as `freshSessionContext`, but the throwaway session is bound to a given
 * credential (issue #854) — needed for AK1–AK3 below, which distinguish "this
 * device" from the others by that binding.
 */
async function sessionContextFor(browser: Browser, baseURL: string | undefined, credentialId: string) {
  const session = await createThrowawaySession(credentialId);
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();
  return { context, page, tokenHash: session.tokenHash };
}

async function credentialCount(): Promise<number> {
  const result = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM credentials'),
  );
  return result.rows[0].n as number;
}

/**
 * `credentials` has no session scoping (single-user app) — AK3 needs an exact
 * starting count, so these destructive tests clear it first rather than guessing
 * what earlier specs left behind. Session validity never depends on this table
 * (`/api/auth/status` reads only `getSession()`), so this cannot break login for
 * whichever spec runs next.
 */
async function deleteAllCredentials(): Promise<void> {
  await withDb((client) => client.query('DELETE FROM credentials'));
}

/**
 * `sessions` has no scoping either. `deleteAllCredentials()` only clears sessions
 * bound to a credential (`ON DELETE CASCADE`, #854) — throwaway sessions minted via
 * `freshSessionContext`/`createThrowawaySession()` without a `credentialId` outlive
 * their test (only the browser context gets closed, never the DB row). AK2 below
 * asserts a global "no other live sessions" count, so it needs both tables clean.
 */
async function deleteAllSessions(): Promise<void> {
  await withDb((client) => client.query('DELETE FROM sessions'));
}

test.describe('sicher (geteilte Sitzung, nie ausloggen)', () => {
  test('AK1: Gruppe "Gerät" zeigt die Karte "Geräte" mit dem registrierten Passkey', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const geraetGroup = page.locator('.einstellungen__group', { hasText: 'Gerät' });
    await expect(geraetGroup.getByRole('heading', { name: 'Geräte', level: 2 })).toBeVisible();
    await expect(geraetGroup.getByText('Unbenanntes Gerät')).toBeVisible();
    await expect(geraetGroup.getByText(/Hinzugefügt am \d{2}\.\d{2}\.\d{4}/)).toBeVisible();
  });

  test('AK6: Karte bleibt im Dark Mode mit reduzierter Bewegung sichtbar und bedienbar (mobiler Viewport)', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/einstellungen');

    const geraetGroup = page.locator('.einstellungen__group', { hasText: 'Gerät' });
    await expect(geraetGroup.getByRole('heading', { name: 'Geräte', level: 2 })).toBeVisible();
    await expect(geraetGroup.getByRole('button', { name: 'Beenden' })).toBeVisible();
  });
});

test.describe('destruktiv (Wegwerf-Sitzung, frischer Context)', () => {
  test('AK2: Widerruf entfernt genau diesen Passkey aus Liste und Postgres, andere bleiben', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    const keptId = await createThrowawayCredential({ label: 'Bleibt' });
    const revokedId = await createThrowawayCredential({ label: 'Weg damit' });

    await page.goto('/einstellungen');
    const row = page.locator('.devices-panel__item', { hasText: 'Weg damit' });
    await row.getByRole('button', { name: 'Widerrufen' }).click();
    await row.getByRole('button', { name: 'Widerrufen' }).click();

    await expect(page.locator('.devices-panel__item', { hasText: 'Weg damit' })).toHaveCount(0);
    expect(await credentialRowExists(revokedId)).toBe(false);
    expect(await credentialRowExists(keptId)).toBe(true);

    await context.close();
  });

  test('AK3: das letzte Gerät ist weder in der UI noch über die API widerrufbar', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    const onlyId = await createThrowawayCredential({ label: 'Einziges Gerät' });
    const { context, page } = await freshSessionContext(browser, baseURL);

    await page.goto('/einstellungen');
    const row = page.locator('.devices-panel__item', { hasText: 'Einziges Gerät' });
    await expect(row.getByRole('button', { name: 'Widerrufen' })).toBeDisabled();
    await expect(page.getByText('Das letzte Gerät kann nicht widerrufen werden.')).toBeVisible();

    const response = await page.request.delete(`/api/auth/credentials/${onlyId}`);
    expect(response.status()).toBe(409);
    expect(await credentialRowExists(onlyId)).toBe(true);

    await context.close();
  });

  test('AK3: zwei gleichzeitige Widerrufe enden bei genau einem verbleibenden Passkey (FOR-UPDATE-Atomizität)', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    const idA = await createThrowawayCredential({ label: 'A' });
    const idB = await createThrowawayCredential({ label: 'B' });
    const { context, page } = await freshSessionContext(browser, baseURL);

    const [responseA, responseB] = await Promise.all([
      page.request.delete(`/api/auth/credentials/${idA}`),
      page.request.delete(`/api/auth/credentials/${idB}`),
    ]);

    expect([responseA.status(), responseB.status()].sort()).toEqual([200, 409]);
    expect(await credentialCount()).toBe(1);

    await context.close();
  });

  test('AK4: „Alle anderen Sitzungen beenden" beendet die fremde Sitzung, lässt die eigene leben', async ({
    browser,
    baseURL,
  }) => {
    const {
      context: contextA,
      page: pageA,
      tokenHash: tokenHashA,
    } = await freshSessionContext(browser, baseURL);
    const sessionB = await createThrowawaySession();
    const contextB = await browser.newContext();
    await contextB.addCookies([{ name: 'starship_session', value: sessionB.token, url: baseURL }]);
    const pageB = await contextB.newPage();

    // "Beenden" lebt seit #857 in der Sitzung-Karte, nicht mehr in der Geräte-Karte.
    const sessionPanel = pageA.locator('.session-panel');
    await pageA.goto('/einstellungen');
    await sessionPanel.getByRole('button', { name: 'Beenden' }).click();
    await sessionPanel.getByRole('button', { name: 'Beenden' }).click();

    await expect.poll(() => sessionRowExists(sessionB.tokenHash)).toBe(false);
    expect(await sessionRowExists(tokenHashA)).toBe(true);

    await pageB.goto('/uebersicht');
    await expect(pageB).toHaveURL(/\/anmelden$/);

    await contextA.close();
    await contextB.close();
  });

  test('AK5: offline ist „Widerrufen" inaktiv mit Hinweis', async ({ browser, baseURL }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawayCredential({ label: 'Offline-Test' });

    await page.goto('/einstellungen');
    await context.setOffline(true);

    // Scoped to the panel's own hint class — session-panel.tsx shows a similarly
    // worded hint in the same "Gerät" group while offline (own #857 AK5 test).
    await expect(
      page.locator('.devices-panel__hint', { hasText: 'Geht nur online.' }),
    ).toBeVisible();
    const row = page.locator('.devices-panel__item', { hasText: 'Offline-Test' });
    await expect(row.getByRole('button', { name: 'Widerrufen' })).toBeDisabled();

    await context.setOffline(false);
    await context.close();
  });
});

test.describe('Gerät hinzufügen (destruktiv, frischer Context)', () => {
  test.beforeEach(async () => {
    await resetRateLimits();
  });

  /**
   * The shared authenticator (`registerPasskey`) already holds the account
   * credential — `excludeCredentials` would match it and `create()` throws
   * `InvalidStateError` (see `openRecoveryDevice` in auth-recovery-register.spec.ts,
   * issue #476). A fresh context with one *seeded* (not registered) credential plus
   * its own virtual authenticator sidesteps that: `firstSetup=false` (no recovery
   * screen), but the fresh authenticator can still enrol a second credential.
   *
   * Clears `credentials` first (same reasoning as `deleteAllCredentials` above) —
   * AK1 asserts an exact total, and earlier tests in this file leave rows behind.
   */
  async function freshDeviceContext(browser: Browser, baseURL: string | undefined) {
    await deleteAllCredentials();
    const session = await createThrowawaySession();
    const context = await browser.newContext();
    await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
    const page = await context.newPage();
    await createThrowawayCredential({ label: 'Bestehend' });
    await enableVirtualAuthenticator(page);
    return { context, page };
  }

  test('AK1: Hinzufügen legt ein zweites Credential mit Label an, kein Recovery-Code', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshDeviceContext(browser, baseURL);
    await page.goto('/einstellungen');

    await page.getByRole('button', { name: 'Gerät hinzufügen' }).click();
    // Scoped to the add-device form itself — the calendar module's "Abo hinzufügen"
    // button (ics-subscriptions-panel.tsx) also matches a bare "Hinzufügen" query by
    // substring, and `.einstellungen__group[hasText: 'Gerät']` is not a safe enough
    // scope either: journal-settings-panel.tsx's "Auf diesem Gerät entsperrt lassen"
    // toggle lives in the "Module" group and matches the same hasText filter.
    const addForm = page.locator('.devices-panel__add-form');
    await addForm.getByLabel('Gerätename').fill('Laptop');
    await addForm.getByRole('button', { name: 'Hinzufügen' }).click();

    await expect(page.locator('.devices-panel__item', { hasText: 'Laptop' })).toBeVisible();
    await expect(page.getByTestId('recovery-code')).toHaveCount(0);

    const rows = await withDb((client) =>
      client.query("SELECT label FROM credentials WHERE label = 'Laptop'"),
    );
    expect(rows.rows).toHaveLength(1);
    expect(await credentialCount()).toBe(2);

    await context.close();
  });

  test('AK2: offline ist „Gerät hinzufügen" inaktiv mit Hinweis', async ({ browser, baseURL }) => {
    const { context, page } = await freshDeviceContext(browser, baseURL);
    await page.goto('/einstellungen');
    await context.setOffline(true);

    await expect(
      page.locator('.devices-panel__hint', { hasText: 'Geht nur online.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gerät hinzufügen' })).toBeDisabled();

    await context.setOffline(false);
    await context.close();
  });

  test('AK3: Aktion bleibt im Dark Mode mit reduzierter Bewegung sichtbar und bedienbar (mobiler Viewport)', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshDeviceContext(browser, baseURL);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/einstellungen');

    const addButton = page.getByRole('button', { name: 'Gerät hinzufügen' });
    await expect(addButton).toBeVisible();
    await addButton.click();
    await expect(page.locator('.devices-panel__add-form').getByLabel('Gerätename')).toBeVisible();

    await context.close();
  });
});

test.describe('#854: Sitzung an Credential gebunden (destruktiv, frischer Context)', () => {
  test('AK1: Widerruf eines Geräts beendet nur dessen Sitzung, andere Geräte leben weiter', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    const idA = await createThrowawayCredential({ label: 'Bedienendes Gerät' });
    const idX = await createThrowawayCredential({ label: 'Widerruf-Ziel' });
    const idY = await createThrowawayCredential({ label: 'Weiteres Gerät' });

    const { context: contextA, page: pageA } = await sessionContextFor(browser, baseURL, idA);
    const { context: contextX, page: pageX, tokenHash: tokenHashX } = await sessionContextFor(
      browser,
      baseURL,
      idX,
    );
    const { context: contextY, tokenHash: tokenHashY } = await sessionContextFor(
      browser,
      baseURL,
      idY,
    );

    await pageA.goto('/einstellungen');
    const row = pageA.locator('.devices-panel__item', { hasText: 'Widerruf-Ziel' });
    await row.getByRole('button', { name: 'Widerrufen' }).click();
    await row.getByRole('button', { name: 'Widerrufen' }).click();

    await expect(
      pageA.locator('.devices-panel__item', { hasText: 'Widerruf-Ziel' }),
    ).toHaveCount(0);
    expect(await credentialRowExists(idX)).toBe(false);
    await expect.poll(() => sessionRowExists(tokenHashX)).toBe(false);
    expect(await sessionRowExists(tokenHashY)).toBe(true);

    await pageX.goto('/uebersicht');
    await expect(pageX).toHaveURL(/\/anmelden$/);

    await contextA.close();
    await contextX.close();
    await contextY.close();
  });

  test('AK2: „Dieses Gerät" markiert nur die Zeile der eigenen Credential', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    const idOwn = await createThrowawayCredential({ label: 'Aktives Gerät' });
    await createThrowawayCredential({ label: 'Zweitgerät' });
    const { context, page } = await sessionContextFor(browser, baseURL, idOwn);

    await page.goto('/einstellungen');
    const rowOwn = page.locator('.devices-panel__item', { hasText: 'Aktives Gerät' });
    const rowOther = page.locator('.devices-panel__item', { hasText: 'Zweitgerät' });
    await expect(rowOwn.getByText('Dieses Gerät')).toBeVisible();
    await expect(rowOther.getByText('Dieses Gerät')).toHaveCount(0);

    await context.close();
  });

  test('AK3: Selbst-Widerruf verlangt eine eigene Bestätigung und meldet ab', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    const idSelf = await createThrowawayCredential({ label: 'Eigenes Gerät' });
    await createThrowawayCredential({ label: 'Anderes Gerät' });
    const { context, page } = await sessionContextFor(browser, baseURL, idSelf);

    await page.goto('/einstellungen');
    // Positional, not hasText: 'Eigenes Gerät' — the confirm step below swaps in copy
    // that no longer contains the label, which would make a hasText filter stop
    // matching mid-test. listCredentialsForDisplay orders by createdAt, so the
    // credential created first (idSelf) is the first row.
    const row = page.locator('.devices-panel__item').first();
    await expect(row).toContainText('Eigenes Gerät');
    await row.getByRole('button', { name: 'Widerrufen' }).click();

    await expect(row.getByText('Das ist dieses Gerät — du wirst abgemeldet')).toBeVisible();
    await expect(row.getByText('„Eigenes Gerät" wirklich widerrufen?')).toHaveCount(0);

    await row.getByRole('button', { name: 'Widerrufen' }).click();

    await expect(page).toHaveURL(/\/anmelden$/);
    expect(await credentialRowExists(idSelf)).toBe(false);

    await context.close();
  });

  test('AK4: Down-Pfad von 0021 entfernt credential_id, Up-Pfad stellt sie wieder her', async () => {
    const downSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/down/0021_colorful_famine.down.sql'),
      'utf8',
    );
    const upSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/0021_colorful_famine.sql'),
      'utf8',
    );

    async function sessionColumns(client: Client): Promise<string[]> {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'`,
      );
      return rows.map((r) => r.column_name as string);
    }

    async function credentialColumns(client: Client): Promise<string[]> {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'credentials'`,
      );
      return rows.map((r) => r.column_name as string);
    }

    await withDb(async (client) => {
      await client.query('BEGIN');
      try {
        const credentialColumnsBefore = await credentialColumns(client);

        await client.query(downSql);
        expect(await sessionColumns(client)).not.toContain('credential_id');
        expect(await credentialColumns(client)).toEqual(credentialColumnsBefore);

        await client.query(upSql);
        expect(await sessionColumns(client)).toContain('credential_id');
        expect(await credentialColumns(client)).toEqual(credentialColumnsBefore);
      } finally {
        // DDL ist in Postgres transaktional — der Rollback macht auch DROP/ADD
        // COLUMN rückgängig, die geteilte Test-DB bleibt unberührt (journal.spec.ts:184).
        await client.query('ROLLBACK');
      }
    });
  });
});

test.describe('#857: Sitzungen an einer Stelle, deutbare Zahl (destruktiv, frischer Context)', () => {
  test('AK1: „App sperren" und „Alle anderen Sitzungen beenden" stehen zusammen in der Sitzung-Karte, kein „Beenden" mehr in der Geräte-Karte', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawaySession();

    await page.goto('/einstellungen');

    const sessionPanel = page.locator('.session-panel');
    await expect(sessionPanel.getByRole('button', { name: 'App sperren' })).toBeVisible();
    await expect(sessionPanel.getByRole('button', { name: 'Beenden' })).toBeVisible();
    const endRow = sessionPanel.locator('.row', { hasText: 'Alle anderen Sitzungen beenden' });
    await expect(endRow).toContainText('App sperren');

    await expect(
      page.locator('.devices-panel').getByRole('button', { name: 'Beenden' }),
    ).toHaveCount(0);

    await context.close();
  });

  test('AK2: ein echter Login coalesct die Alt-Sitzungen desselben Passkeys — die Zahl entspricht anderen Geräten', async ({
    browser,
  }) => {
    await deleteAllCredentials();
    await deleteAllSessions();
    const context = await browser.newContext();
    const page = await context.newPage();
    await enableVirtualAuthenticator(page);

    // Registrierung mintet Credential C und (No-op-Coalescing) Sitzung S1.
    await page.goto('/anmelden');
    await page.getByRole('button', { name: 'Passkey einrichten' }).click();
    await page.getByTestId('recovery-code').waitFor();
    await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
    await page.waitForURL('**/uebersicht');

    const { rows: credentialRows } = await withDb((client) =>
      client.query('SELECT id FROM credentials ORDER BY created_at DESC LIMIT 1'),
    );
    const credentialId = credentialRows[0].id as string;

    async function sessionCountFor(id: string): Promise<number> {
      const result = await withDb((client) =>
        client.query('SELECT count(*)::int AS n FROM sessions WHERE credential_id = $1', [id]),
      );
      return result.rows[0].n as number;
    }

    // Zwei direkt geseedete Alt-Sitzungen desselben Passkeys — Anmelde-Rückstand,
    // der createSession() nie zu sehen bekam und darum nie coalescte (Rest-Altlast
    // aus der Zeit vor #857).
    await createThrowawaySession(credentialId);
    await createThrowawaySession(credentialId);
    expect(await sessionCountFor(credentialId)).toBe(3);

    // "App sperren" beendet nur die aktuelle Sitzung serverseitig (S1).
    await page.goto('/einstellungen');
    const sessionPanel = page.locator('.session-panel');
    await sessionPanel.getByRole('button', { name: 'App sperren' }).click();
    await sessionPanel.getByRole('button', { name: 'Sperren' }).click();
    await page.waitForURL('**/anmelden');

    // Nur der echte Login-Pfad ruft createSession(C) und coalesct damit die beiden
    // geseedeten Alt-Sitzungen weg — direkt geseedete Sitzungen umgehen das.
    await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await page.waitForURL('**/uebersicht');

    expect(await sessionCountFor(credentialId)).toBe(1);

    await page.goto('/einstellungen');
    await expect(
      page.locator('.session-panel').getByText('Keine weiteren aktiven Sitzungen'),
    ).toBeVisible();

    await context.close();
  });

  test('AK3: Down-Pfad von 0022 stellt last_seen_at wieder her, Up-Pfad entfernt sie erneut', async () => {
    const downSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/down/0022_melted_zarda.down.sql'),
      'utf8',
    );
    const upSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/0022_melted_zarda.sql'),
      'utf8',
    );

    async function sessionColumns(client: Client): Promise<string[]> {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'`,
      );
      return rows.map((r) => r.column_name as string);
    }

    await withDb(async (client) => {
      await client.query('BEGIN');
      try {
        const columnsBefore = await sessionColumns(client);
        expect(columnsBefore).not.toContain('last_seen_at');

        await client.query(downSql);
        expect(await sessionColumns(client)).toContain('last_seen_at');

        await client.query(upSql);
        expect(await sessionColumns(client)).toEqual(columnsBefore);
      } finally {
        // DDL ist in Postgres transaktional — der Rollback macht auch ADD/DROP
        // COLUMN rückgängig, die geteilte Test-DB bleibt unberührt (journal.spec.ts:184).
        await client.query('ROLLBACK');
      }
    });
  });

  test('AK4: „Alle anderen Sitzungen beenden" lässt die eigene weiterleben, der Bezug zu „App sperren" ist erklärt', async ({
    browser,
    baseURL,
  }) => {
    const {
      context: contextA,
      page: pageA,
      tokenHash: tokenHashA,
    } = await freshSessionContext(browser, baseURL);
    const sessionB = await createThrowawaySession();

    await pageA.goto('/einstellungen');
    const sessionPanel = pageA.locator('.session-panel');
    const endRow = sessionPanel.locator('.row', { hasText: 'Alle anderen Sitzungen beenden' });
    await expect(endRow).toContainText('App sperren');

    await sessionPanel.getByRole('button', { name: 'Beenden' }).click();
    await sessionPanel.getByRole('button', { name: 'Beenden' }).click();

    await expect.poll(() => sessionRowExists(sessionB.tokenHash)).toBe(false);
    expect(await sessionRowExists(tokenHashA)).toBe(true);

    await contextA.close();
  });

  test('AK5: offline sind „App sperren" und „Alle anderen Sitzungen beenden" inaktiv mit Hinweis', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawaySession();

    await page.goto('/einstellungen');
    await context.setOffline(true);

    const sessionPanel = page.locator('.session-panel');
    await expect(
      sessionPanel.locator('.session-panel__hint', { hasText: 'Geht nur online.' }),
    ).toBeVisible();
    await expect(sessionPanel.getByRole('button', { name: 'App sperren' })).toBeDisabled();
    await expect(sessionPanel.getByRole('button', { name: 'Beenden' })).toBeDisabled();

    await context.setOffline(false);
    await context.close();
  });

  test('AK6: Karte bleibt im Dark Mode mit reduzierter Bewegung sichtbar und bedienbar (mobiler Viewport)', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawaySession();
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });

    await page.goto('/einstellungen');
    const sessionPanel = page.locator('.session-panel');
    await expect(sessionPanel.getByRole('button', { name: 'App sperren' })).toBeVisible();
    await expect(sessionPanel.getByRole('button', { name: 'Beenden' })).toBeVisible();

    await context.close();
  });
});
