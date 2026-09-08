import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
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
  test('AK1 (#1103): Gruppe "Gerät" zeigt die Karte "Passkeys" mit dem registrierten Passkey und dem iCloud-Hinweis', async ({
    page,
  }) => {
    await registerPasskey(page, '/einstellungen');

    const geraetGroup = page.locator('.einstellungen__group', { hasText: 'Gerät' });
    await expect(geraetGroup.getByRole('heading', { name: 'Passkeys', level: 2 })).toBeVisible();
    await expect(geraetGroup.getByText('Unbenanntes Gerät')).toBeVisible();
    await expect(geraetGroup.getByText(/Hinzugefügt am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/)).toBeVisible();
    await expect(
      geraetGroup.getByText(/iCloud-Schlüsselbund synchronisierter Passkey ist auf allen deinen Apple-Geräten derselbe/),
    ).toBeVisible();
    await expect(
      geraetGroup.getByText(/im Passkey-Dialog einen anderen Speicherort wählen/),
    ).toBeVisible();
  });

  test('AK6: Karte bleibt im Dark Mode mit reduzierter Bewegung sichtbar und bedienbar (mobiler Viewport)', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/einstellungen');

    const geraetGroup = page.locator('.einstellungen__group', { hasText: 'Gerät' });
    await expect(geraetGroup.getByRole('heading', { name: 'Passkeys', level: 2 })).toBeVisible();
    await expect(geraetGroup.getByRole('button', { name: 'Beenden' })).toBeVisible();
  });

  test('#936 AK1+AK2: „Umbenennen" und „Widerrufen" stehen unter Name/Zusatzzeile, mit ≥44px Höhe (375×812)', async ({
    page,
  }) => {
    await registerPasskey(page, '/einstellungen');

    const row = page.locator('.devices-panel__item', { hasText: 'Unbenanntes Gerät' });
    const description = row.locator('.row__description');
    const renameButton = row.getByRole('button', { name: 'Umbenennen' });
    const revokeButton = row.getByRole('button', { name: 'Widerrufen' });

    await expect(description).toBeVisible();
    await expect(renameButton).toBeVisible();
    await expect(revokeButton).toBeVisible();

    const descriptionBox = await description.boundingBox();
    const renameBox = await renameButton.boundingBox();
    const revokeBox = await revokeButton.boundingBox();

    expect(descriptionBox!.y + descriptionBox!.height, 'Umbenennen-Knopf unter der Zusatzzeile').toBeLessThanOrEqual(
      renameBox!.y + 1,
    );
    expect(descriptionBox!.y + descriptionBox!.height, 'Widerrufen-Knopf unter der Zusatzzeile').toBeLessThanOrEqual(
      revokeBox!.y + 1,
    );
    expect(renameBox!.height, 'Umbenennen-Knopf ≥44px hoch').toBeGreaterThanOrEqual(44);
    expect(revokeBox!.height, 'Widerrufen-Knopf ≥44px hoch').toBeGreaterThanOrEqual(44);

    const viewport = page.viewportSize()!;
    expect(renameBox!.x, 'Umbenennen-Knopf innerhalb 375px Breite').toBeGreaterThanOrEqual(0);
    expect(renameBox!.x + renameBox!.width, 'Umbenennen-Knopf ragt nicht heraus').toBeLessThanOrEqual(
      viewport.width,
    );
    expect(revokeBox!.x + revokeBox!.width, 'Widerrufen-Knopf ragt nicht heraus').toBeLessThanOrEqual(
      viewport.width,
    );
  });

  test('#936 AK4: Anordnung bleibt im Dark Mode mit reduzierter Bewegung erhalten (375×812)', async ({ page }) => {
    await registerPasskey(page);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/einstellungen');

    const row = page.locator('.devices-panel__item', { hasText: 'Unbenanntes Gerät' });
    const description = row.locator('.row__description');
    const renameButton = row.getByRole('button', { name: 'Umbenennen' });
    const revokeButton = row.getByRole('button', { name: 'Widerrufen' });

    await expect(renameButton).toBeVisible();
    await expect(revokeButton).toBeVisible();

    const descriptionBox = await description.boundingBox();
    const renameBox = await renameButton.boundingBox();
    expect(descriptionBox!.y + descriptionBox!.height).toBeLessThanOrEqual(renameBox!.y + 1);
    expect(renameBox!.height).toBeGreaterThanOrEqual(44);
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

test.describe('#856: Gerät hinzufügen durch Recovery-Hinweis ersetzt (frischer Context)', () => {
  test('AK5: Panel zeigt Recovery-Hinweis statt „Gerät hinzufügen"-Knopf', async ({
    browser,
    baseURL,
  }) => {
    await deleteAllCredentials();
    await createThrowawayCredential({ label: 'Bestehend' });
    const { context, page } = await freshSessionContext(browser, baseURL);

    await page.goto('/einstellungen');

    await expect(
      page.getByText(
        'Neues Gerät hinzufügen? Öffne die App auf dem neuen Gerät und melde es unter „Anmelden" mit deinem Recovery-Code an.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gerät hinzufügen' })).toHaveCount(0);

    await context.close();
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

  test('AK2: das namenlose Erstgerät ist umbenennbar', async ({ browser, baseURL }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    const id = await createThrowawayCredential({});

    await page.goto('/einstellungen');
    const row = page.locator('.devices-panel__item', { hasText: 'Unbenanntes Gerät' });
    await row.getByRole('button', { name: 'Umbenennen' }).click();
    await page.getByLabel('Neuer Name').fill('Mein iPhone');
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect(page.locator('.devices-panel__item', { hasText: 'Mein iPhone' })).toBeVisible();
    const rows = await withDb((client) =>
      client.query('SELECT label FROM credentials WHERE id = $1', [id]),
    );
    expect(rows.rows[0].label).toBe('Mein iPhone');

    await context.close();
  });

  test('AK3: ein neu beim Erstsetup angelegtes Gerät kann direkt benannt werden', async ({
    browser,
  }) => {
    await resetRateLimits();
    await deleteAllCredentials();
    const context = await browser.newContext();
    const page = await context.newPage();
    await enableVirtualAuthenticator(page);

    await page.goto('/anmelden');
    await page.getByLabel('Gerätename (optional)').fill('Erstes iPhone');
    await page.getByRole('button', { name: 'Passkey einrichten' }).click();
    await page.getByTestId('recovery-code').waitFor();
    await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
    await page.waitForURL('**/uebersicht');

    const rows = await withDb((client) =>
      client.query("SELECT label FROM credentials WHERE label = 'Erstes iPhone'"),
    );
    expect(rows.rows).toHaveLength(1);

    await page.goto('/einstellungen');
    await expect(page.locator('.devices-panel__item', { hasText: 'Erstes iPhone' })).toBeVisible();

    await context.close();
  });

  test('AK4: leerer Name setzt wieder auf „Unbenanntes Gerät" zurück', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    const id = await createThrowawayCredential({ label: 'Hat Namen' });

    await page.goto('/einstellungen');
    const row = page.locator('.devices-panel__item', { hasText: 'Hat Namen' });
    await row.getByRole('button', { name: 'Umbenennen' }).click();
    await page.getByLabel('Neuer Name').fill('');
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect(
      page.locator('.devices-panel__item', { hasText: 'Unbenanntes Gerät' }),
    ).toBeVisible();
    const rows = await withDb((client) =>
      client.query('SELECT label FROM credentials WHERE id = $1', [id]),
    );
    expect(rows.rows[0].label).toBeNull();

    await context.close();
  });

  test('AK5a: offline ist „Umbenennen" inaktiv mit Hinweis', async ({ browser, baseURL }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawayCredential({ label: 'Offline-Test' });

    await page.goto('/einstellungen');
    await context.setOffline(true);

    await expect(
      page.locator('.devices-panel__hint', { hasText: 'Geht nur online.' }),
    ).toBeVisible();
    const row = page.locator('.devices-panel__item', { hasText: 'Offline-Test' });
    await expect(row.getByRole('button', { name: 'Umbenennen' })).toBeDisabled();

    await context.setOffline(false);
    await context.close();
  });

  test('AK5b: Umbenennen-Feld bleibt im Dark Mode mit reduzierter Bewegung bedienbar (mobiler Viewport)', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawayCredential({ label: 'Dark-Test' });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/einstellungen');

    const row = page.locator('.devices-panel__item', { hasText: 'Dark-Test' });
    await row.getByRole('button', { name: 'Umbenennen' }).click();
    await expect(page.getByLabel('Neuer Name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern' })).toBeVisible();

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

test.describe('#1102: Anmeldungen je (Passkey, Gerät) (destruktiv, frischer Context)', () => {
  /**
   * The full ceremony inline rather than `registerPasskey` — that helper writes
   * `AUTH_STATE`, and these tests delete every credential and session, so the
   * shared storage state must not be re-pointed at one of them (same reason the
   * #857 block above does it by hand).
   */
  async function registerFreshDevice(browser: Browser) {
    await deleteAllCredentials();
    await deleteAllSessions();
    const context = await browser.newContext();
    const page = await context.newPage();
    await enableVirtualAuthenticator(page);

    await page.goto('/anmelden');
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

  test('AK7: die Einstellungen bleiben auf dem iPhone im Dark Mode unverändert bedienbar', async ({
    browser,
    baseURL,
  }) => {
    const session = await createThrowawaySession(undefined, randomUUID());
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
    const page = await context.newPage();

    await page.goto('/einstellungen');
    await expect(page.locator('.devices-panel')).toBeVisible();
    await expect(page.locator('.session-panel')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

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
    await withDb((client) =>
      client.query(
        'INSERT INTO sessions (id, token_hash, expires_at, device_id) VALUES ($1, $2, $3, $4)',
        [randomUUID(), randomUUID(), new Date(Date.now() - 1000), randomUUID()],
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

  test('AK5: die eigene Zeile hat kein "Beenden", sondern den Verweis auf „App sperren"', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);

    await page.goto('/einstellungen');
    const ownRow = page.locator('.logins-panel__item', { hasText: 'Dieses Gerät' });
    await expect(ownRow.getByRole('button', { name: 'Beenden' })).toHaveCount(0);
    await expect(ownRow.getByText('App sperren')).toBeVisible();

    await context.close();
  });

  test('AK7: „Anmeldungen" bleibt auf dem iPhone im Dark Mode sichtbar, offline mit Hinweis', async ({
    browser,
    baseURL,
  }) => {
    const session = await createThrowawaySession(undefined, randomUUID());
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
    const page = await context.newPage();

    await page.goto('/einstellungen');
    const loginsPanel = page.locator('.logins-panel');
    await expect(loginsPanel).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await context.setOffline(true);
    await expect(loginsPanel.getByText('Geht nur online.')).toBeVisible();

    await context.setOffline(false);
    await context.close();
  });
});
