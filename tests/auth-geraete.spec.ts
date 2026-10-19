import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { Client } from 'pg';
import {
  createThrowawayCredential,
  createThrowawaySession,
  credentialRowExists,
  currentAccountId,
  enableVirtualAuthenticator,
  resetAppData,
  seedInvite,
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
 * their test (only the browser context gets closed, never the DB row). The
 * session tests below assert exact counts of live sessions, so they need both
 * tables clean.
 */
async function deleteAllSessions(): Promise<void> {
  await withDb((client) => client.query('DELETE FROM sessions'));
}

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
});

test.describe('Gerät umbenennen (destruktiv, frischer Context)', () => {
  test('AK1: Umbenennen überlebt Reload und steht in Postgres', async ({ browser, baseURL }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    const id = await createThrowawayCredential({ label: 'Alt' });

    await page.goto('/einstellungen');
    const row = page.locator('.devices-panel__item', { hasText: 'Alt' });
    await row.getByRole('button', { name: 'Umbenennen' }).click();
    // Not `row.getByLabel(...)` from here — "Alt" leaves the row's text once the
    // form replaces it, so the `hasText` filter would no longer match anything.
    await page.getByLabel('Neuer Name').fill('Neuer Name');
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect(page.locator('.devices-panel__item', { hasText: 'Neuer Name' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.devices-panel__item', { hasText: 'Neuer Name' })).toBeVisible();

    const rows = await withDb((client) =>
      client.query('SELECT label FROM credentials WHERE id = $1', [id]),
    );
    expect(rows.rows[0].label).toBe('Neuer Name');

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
        // COLUMN rückgängig, die geteilte Test-DB bleibt unberührt (wie im 0012-Migrationstest in journal.spec.ts).
        await client.query('ROLLBACK');
      }
    });
  });
});

test.describe('#857: Sitzungen an einer Stelle, deutbare Zahl (destruktiv, frischer Context)', () => {
  test('AK6 (#1103): Migration 0025 hat einen Rückweg — down entfernt last_seen_at, up legt sie wieder an', async () => {
    // last_seen_at kommt in #1103 belebt zurück (Retarget von 0022 auf 0025 —
    // die alte 0022-Prämisse "last_seen_at existiert nicht" gilt seither nicht mehr).
    const downSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/down/0025_needy_hobgoblin.down.sql'),
      'utf8',
    );
    const upSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/0025_needy_hobgoblin.sql'),
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
        expect(columnsBefore).toContain('last_seen_at');

        await client.query(downSql);
        expect(await sessionColumns(client)).not.toContain('last_seen_at');

        await client.query(upSql);
        // Sortiert verglichen, wie die #1102-Runde weiter unten: `DROP COLUMN` +
        // `ADD COLUMN` hängt die Spalte physisch hinten an. Bis #1200 war
        // `last_seen_at` ohnehin die letzte, der Rundlauf erhielt die Reihenfolge
        // also zufällig; seit `user_id` dahinter steht, tut er das nicht mehr.
        // Geprüft war immer gemeint: dieselbe *Menge* an Spalten kommt zurück.
        expect((await sessionColumns(client)).sort()).toEqual([...columnsBefore].sort());
      } finally {
        // DDL ist in Postgres transaktional — der Rollback macht auch ADD/DROP
        // COLUMN rückgängig, die geteilte Test-DB bleibt unberührt (wie im 0012-Migrationstest in journal.spec.ts).
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

  test('AK5: offline bleibt nur „Alle anderen Sitzungen beenden" inaktiv — „App sperren" sperrt weiterhin lokal (#1201 AK7)', async ({
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
    await expect(sessionPanel.getByRole('button', { name: 'App sperren' })).toBeEnabled();
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

test.describe('#1102: Anmeldungen je (Passkey, Gerät) (destruktiv, frischer Context)', () => {
  /**
   * The full ceremony inline rather than `registerPasskey` — that helper writes
   * `AUTH_STATE`, and these tests delete every credential and session, so the
   * shared storage state must not be re-pointed at one of them (same reason the
   * #857 block above does it by hand).
   */
  async function registerFreshDevice(browser: Browser) {
    // Credential-less no longer opens registration on its own (#1202, AK5) — an
    // invite pre-bound to the still-existing admin account stands in for "lost
    // every device", same shape `scripts/bootstrap-admin.ts` produces.
    const adminId = await currentAccountId();
    await deleteAllCredentials();
    await deleteAllSessions();
    const token = await seedInvite({ createdBy: adminId, userId: adminId });
    const context = await browser.newContext();
    const page = await context.newPage();
    await enableVirtualAuthenticator(page);

    await page.goto(`/einladung/${token}`);
    await page.getByRole('button', { name: 'Passkey einrichten' }).click();
    await page.getByTestId('recovery-code').waitFor();
    await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
    await page.waitForURL('**/uebersicht');

    const { rows } = await withDb((client) =>
      client.query('SELECT id FROM credentials ORDER BY created_at DESC LIMIT 1'),
    );
    return { context, page, credentialId: rows[0].id as string };
  }

  async function deviceCookie(context: Awaited<ReturnType<Browser['newContext']>>) {
    return (await context.cookies()).find((cookie) => cookie.name === 'starship_device');
  }

  /** Locks the app server-side and signs back in with the same passkey. */
  async function lockAndLogIn(page: Page) {
    await page.goto('/einstellungen');
    const sessionPanel = page.locator('.session-panel');
    await sessionPanel.getByRole('button', { name: 'App sperren' }).click();
    await sessionPanel.getByRole('button', { name: 'Sperren' }).click();
    await page.waitForURL('**/anmelden');

    await page.getByRole('button', { name: 'Mit Passkey anmelden' }).click();
    await page.waitForURL('**/uebersicht');
  }

  test('AK1: Migration 0023 hat einen Rückweg — down entfernt device_id, up legt sie wieder an', async () => {
    const downSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/down/0023_silky_kitty_pryde.down.sql'),
      'utf8',
    );
    const upSql = readFileSync(
      path.join(__dirname, '../src/db/migrations/0023_silky_kitty_pryde.sql'),
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
        expect(columnsBefore).toContain('device_id');

        await client.query(downSql);
        expect(await sessionColumns(client)).not.toContain('device_id');

        // Sortiert vergleichen, nicht als Array: `ADD COLUMN` hängt physisch immer
        // ans Ende an, seit #1103 last_seen_at (0025) *nach* device_id (0023) kam.
        // Ein Down/Up-Zyklus von 0023 verschiebt device_id deshalb hinter
        // last_seen_at — die Spaltenmenge stimmt wieder, die Reihenfolge nicht, und
        // die ist für keinen Aufrufer (Drizzle liest per Name) je bedeutungsvoll.
        await client.query(upSql);
        expect((await sessionColumns(client)).sort()).toEqual([...columnsBefore].sort());
      } finally {
        // DDL ist in Postgres transaktional — der Rollback macht auch ADD/DROP
        // COLUMN rückgängig, die geteilte Test-DB bleibt unberührt.
        await client.query('ROLLBACK');
      }
    });
  });

  test('AK2: der Login vergibt eine Geräte-ID — Cookie und sessions.device_id tragen denselben Wert, das Cookie überlebt die Sitzung', async ({
    browser,
  }) => {
    const { context, credentialId } = await registerFreshDevice(browser);

    const device = await deviceCookie(context);
    expect(device).toBeDefined();
    expect(device?.value).not.toBe('');
    expect(device?.httpOnly).toBe(true);
    expect(device?.sameSite).toBe('Lax');
    expect(device?.path).toBe('/');

    const session = (await context.cookies()).find((cookie) => cookie.name === 'starship_session');
    // Ein Geräte-Cookie, das vor der Sitzung abläuft, macht aus einem lebenden
    // Gerät beim nächsten Login ein neues — genau die Altlast, die device_id
    // vermeiden soll.
    expect(device!.expires).toBeGreaterThan(session!.expires);

    const { rows } = await withDb((client) =>
      client.query('SELECT device_id FROM sessions WHERE credential_id = $1', [credentialId]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe(device!.value);

    await context.close();
  });

  test('AK3: eine Anmeldung desselben Passkeys von einem anderen Gerät überlebt den Login', async ({
    browser,
  }) => {
    const { context, page, credentialId } = await registerFreshDevice(browser);

    // Das zweite Apple-Gerät am selben Schlüsselbund: derselbe Passkey, andere
    // Geräte-ID. Vor #1102 hat der Login hier die andere Sitzung gelöscht.
    const other = await createThrowawaySession(credentialId, randomUUID());

    await lockAndLogIn(page);

    expect(await sessionRowExists(other.tokenHash)).toBe(true);

    await context.close();
  });

  test('AK4: Anmeldungen desselben Geräts und Altlasten ohne Geräte-ID werden weiterhin eingedampft', async ({
    browser,
  }) => {
    const { context, page, credentialId } = await registerFreshDevice(browser);
    const device = await deviceCookie(context);

    const sameDevice = await createThrowawaySession(credentialId, device!.value);
    // device_id IS NULL: Anmeldung von vor #1102, keinem Gerät zuzuordnen.
    const legacy = await createThrowawaySession(credentialId);

    await lockAndLogIn(page);

    expect(await sessionRowExists(sameDevice.tokenHash)).toBe(false);
    expect(await sessionRowExists(legacy.tokenHash)).toBe(false);

    await context.close();
  });

  test('AK5: ein verlorenes Geräte-Cookie heilt aus der Sitzungszeile, ohne eine zweite Anmeldung anzulegen', async ({
    browser,
  }) => {
    const { context, page, credentialId } = await registerFreshDevice(browser);
    const before = await deviceCookie(context);

    async function sessionRows() {
      const { rows } = await withDb((client) =>
        client.query('SELECT device_id FROM sessions WHERE credential_id = $1', [credentialId]),
      );
      return rows as Array<{ device_id: string | null }>;
    }
    expect(await sessionRows()).toHaveLength(1);

    await context.clearCookies({ name: 'starship_device' });
    expect(await deviceCookie(context)).toBeUndefined();

    const response = await page.request.get('/api/auth/sessions');
    expect(response.ok()).toBe(true);

    const after = await deviceCookie(context);
    expect(after?.value).toBe(before!.value);

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe(before!.value);

    await context.close();
  });

  test('AK6: die Geräte-ID autorisiert nichts — ohne Sitzung 401, mit fremdem Wert bleibt die Zeile unberührt', async ({
    browser,
    baseURL,
  }) => {
    const strangerContext = await browser.newContext();
    await strangerContext.addCookies([
      { name: 'starship_device', value: randomUUID(), url: baseURL },
    ]);
    const strangerResponse = await strangerContext.request.get('/api/auth/sessions');
    expect(strangerResponse.status()).toBe(401);
    await strangerContext.close();

    const ownDeviceId = randomUUID();
    const session = await createThrowawaySession(undefined, ownDeviceId);
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'starship_session', value: session.token, url: baseURL },
      { name: 'starship_device', value: randomUUID(), url: baseURL },
    ]);

    const response = await context.request.get('/api/auth/sessions');
    expect(response.ok()).toBe(true);

    const { rows } = await withDb((client) =>
      client.query('SELECT device_id FROM sessions WHERE token_hash = $1', [session.tokenHash]),
    );
    expect(rows[0].device_id).toBe(ownDeviceId);
    // Die Zeile gewinnt: der fremde Wert wird im Browser korrigiert, nicht in der DB.
    expect((await deviceCookie(context))?.value).toBe(ownDeviceId);

    await context.close();
  });
});

test.describe('#1103: Karte "Anmeldungen" (destruktiv, frischer Context)', () => {
  // `sessions` hat keine Scoping (single-user app, siehe deleteAllSessions oben) —
  // ohne das hier akkumulieren frühere Specs' Wegwerf-Sitzungen in der geteilten
  // Test-DB, und listSessions() (systemweit, keine Test-Grenze) liefert für jede
  // Zeilenzahl-Assertion unten viel zu viele Treffer.
  test.beforeEach(async () => {
    await deleteAllSessions();
  });

  test('AK2: listet lebende Sitzungen mit unterschiedlicher Geräte-ID, abgelaufene fehlen', async ({
    browser,
    baseURL,
  }) => {
    const own = await createThrowawaySession(undefined, randomUUID());
    const context = await browser.newContext();
    await context.addCookies([{ name: 'starship_session', value: own.token, url: baseURL }]);
    const page = await context.newPage();

    await createThrowawaySession(undefined, randomUUID());
    // Abgelaufene Sitzung, direkt geseedet — darf in der Liste nicht auftauchen.
    // Sie hängt am selben Konto wie die beiden lebenden (#1200): an einem fremden
    // wäre sie schon durch die Mandantentrennung unsichtbar, und der Test würde
    // dann die Ablauf-Filterung gar nicht mehr prüfen.
    const account = await currentAccountId();
    await withDb((client) =>
      client.query(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at, device_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), account, randomUUID(), new Date(Date.now() - 1000), randomUUID()],
      ),
    );

    await page.goto('/einstellungen');
    const loginsPanel = page.locator('.logins-panel');
    await expect(loginsPanel.locator('.logins-panel__item')).toHaveCount(2);
    await expect(loginsPanel.getByText('Dieses Gerät')).toBeVisible();

    await context.close();
  });

  test('AK3: „zuletzt gesehen" wird gedrosselt fortgeschrieben — höchstens 1x je Stunde', async ({
    browser,
    baseURL,
  }) => {
    const session = await createThrowawaySession(undefined, randomUUID());
    const context = await browser.newContext();
    await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);

    async function lastSeenAt(): Promise<Date | null> {
      const { rows } = await withDb((client) =>
        client.query('SELECT last_seen_at FROM sessions WHERE token_hash = $1', [session.tokenHash]),
      );
      return rows[0].last_seen_at as Date | null;
    }

    expect(await lastSeenAt()).toBeNull();

    expect((await context.request.get('/api/auth/sessions')).ok()).toBe(true);
    const fresh = await lastSeenAt();
    expect(fresh).not.toBeNull();
    expect(Date.now() - fresh!.getTime()).toBeLessThan(60_000);

    // Innerhalb der Drossel (30 Minuten) — ein zweiter Aufruf schreibt nicht erneut.
    const withinThrottle = new Date(Date.now() - 30 * 60 * 1000);
    await withDb((client) =>
      client.query('UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2', [
        withinThrottle,
        session.tokenHash,
      ]),
    );
    await context.request.get('/api/auth/sessions');
    expect(Math.abs((await lastSeenAt())!.getTime() - withinThrottle.getTime())).toBeLessThan(1000);

    // Fenster überschritten (2 Stunden) — der nächste Aufruf schreibt wieder frisch.
    const pastThrottle = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await withDb((client) =>
      client.query('UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2', [
        pastThrottle,
        session.tokenHash,
      ]),
    );
    await context.request.get('/api/auth/sessions');
    expect(Date.now() - (await lastSeenAt())!.getTime()).toBeLessThan(60_000);

    await context.close();
  });

  test('AK4: „Beenden" an einer fremden Zeile löscht genau diese Sitzung, die eigene bleibt', async ({
    browser,
    baseURL,
  }) => {
    const { context, page, tokenHash: ownHash } = await freshSessionContext(browser, baseURL);
    const other = await createThrowawaySession(undefined, randomUUID());

    await page.goto('/einstellungen');
    const loginsPanel = page.locator('.logins-panel');
    await expect(loginsPanel.locator('.logins-panel__item')).toHaveCount(2);

    const foreignRow = loginsPanel
      .locator('.logins-panel__item')
      .filter({ hasNotText: 'Dieses Gerät' });
    await foreignRow.getByRole('button', { name: 'Beenden' }).click();
    await foreignRow.getByRole('button', { name: 'Beenden' }).click();

    await expect.poll(() => sessionRowExists(other.tokenHash)).toBe(false);
    expect(await sessionRowExists(ownHash)).toBe(true);
    await expect(loginsPanel.locator('.logins-panel__item')).toHaveCount(1);

    await context.close();
  });
});
