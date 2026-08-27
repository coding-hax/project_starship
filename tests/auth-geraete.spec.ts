import { expect, test, type Browser } from '@playwright/test';
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

    await pageA.goto('/einstellungen');
    await pageA.getByRole('button', { name: 'Beenden' }).click();
    await pageA.getByRole('button', { name: 'Beenden' }).click();

    await expect.poll(() => sessionRowExists(sessionB.tokenHash)).toBe(false);
    expect(await sessionRowExists(tokenHashA)).toBe(true);

    await pageB.goto('/uebersicht');
    await expect(pageB).toHaveURL(/\/anmelden$/);

    await contextA.close();
    await contextB.close();
  });

  test('AK5: offline sind „Widerrufen" und „Alle anderen Sitzungen beenden" inaktiv mit Hinweis', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await createThrowawayCredential({ label: 'Offline-Test' });
    await createThrowawaySession();

    await page.goto('/einstellungen');
    await context.setOffline(true);

    // Scoped to the panel's own hint class — session-panel.tsx shows a similarly
    // worded "Sperren geht nur online." hint in the same "Gerät" group while offline.
    await expect(
      page.locator('.devices-panel__hint', { hasText: 'Geht nur online.' }),
    ).toBeVisible();
    const row = page.locator('.devices-panel__item', { hasText: 'Offline-Test' });
    await expect(row.getByRole('button', { name: 'Widerrufen' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Beenden' })).toBeDisabled();

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
