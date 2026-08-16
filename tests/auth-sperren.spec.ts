import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  createThrowawaySession,
  registerPasskey,
  resetAppData,
  sessionRowExists,
  settleJournalHabitBoot,
  withDb,
} from './helpers';

const PASSPHRASE = 'correct horse battery staple';

test.beforeEach(async () => {
  await resetAppData();
});

/**
 * A fresh context with its own throwaway `sessions` row (issue #756) — never the
 * shared `AUTH_STATE` session every other project's `storageState` depends on.
 * `registerPasskey` short-circuits on the valid cookie (no WebAuthn ceremony needed).
 */
async function freshSessionContext(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page; tokenHash: string }> {
  const session = await createThrowawaySession();
  const context = await browser.newContext();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  const page = await context.newPage();
  return { context, page, tokenHash: session.tokenHash };
}

async function addThrowawayCookie(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<string> {
  const session = await createThrowawaySession();
  await context.addCookies([{ name: 'starship_session', value: session.token, url: baseURL }]);
  return session.tokenHash;
}

/** Mirrors `setUpJournal` in journal-lock.spec.ts:25. */
async function setUpJournal(page: Page, passphrase: string) {
  await registerPasskey(page);
  await page.goto('/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

async function journalKeyRowCount(): Promise<number> {
  const result = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM journal_keys'),
  );
  return result.rows[0].n as number;
}

async function lock(page: Page) {
  await page.getByRole('button', { name: 'App sperren' }).click();
  await page.getByRole('button', { name: 'Sperren' }).click();
  await page.waitForURL('**/anmelden');
}

test.describe('sicher (geteilte Sitzung, nie ausloggen)', () => {
  test('AC1: Gruppe "Gerät" zeigt die Karte "Sitzung" mit Knopf "App sperren"', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    const geraetGroup = page.locator('.einstellungen__group', { hasText: 'Gerät' });
    await expect(geraetGroup.getByRole('heading', { name: 'Sitzung', level: 2 })).toBeVisible();
    await expect(geraetGroup.getByRole('button', { name: 'App sperren' })).toBeVisible();
  });

  test('AC2: der Knopf fragt inline nach, ohne die Sitzung zu beenden', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');

    let logoutCalls = 0;
    await page.route('**/api/auth/logout', (route) => {
      logoutCalls += 1;
      return route.continue();
    });

    await page.getByRole('button', { name: 'App sperren' }).click();
    await expect(page.getByText('Wirklich sperren?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sperren' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abbrechen' })).toBeVisible();
    expect(logoutCalls).toBe(0);

    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByRole('button', { name: 'App sperren' })).toBeVisible();
    await expect(page).toHaveURL(/\/einstellungen$/);
    expect(logoutCalls).toBe(0);
  });

  test('AC6: offline ist der Knopf inaktiv mit Hinweis, dass Sperren nur online geht', async ({
    page,
    context,
  }) => {
    await registerPasskey(page);
    await page.goto('/einstellungen');
    await context.setOffline(true);

    await expect(page.getByRole('button', { name: 'App sperren' })).toBeDisabled();
    await expect(page.getByText('Sperren geht nur online.')).toBeVisible();

    await context.setOffline(false);
  });
});

test.describe('destruktiv (Wegwerf-Sitzung, frischer Context)', () => {
  test('AC3: Bestätigen beendet die Sitzung serverseitig und landet auf /anmelden', async ({
    browser,
    baseURL,
  }) => {
    const { context, page, tokenHash } = await freshSessionContext(browser, baseURL);
    await page.goto('/einstellungen');

    await lock(page);

    expect(await sessionRowExists(tokenHash)).toBe(false);
    const others = await withDb((client) =>
      client.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash <> $1', [tokenHash]),
    );
    expect(others.rows[0].n).toBeGreaterThanOrEqual(1);

    await context.close();
  });

  test('AC4: nach dem Sperren leitet ein direkter Aufruf einer geschützten Route auf /anmelden', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await page.goto('/einstellungen');

    await lock(page);

    await page.goto('/uebersicht');
    await expect(page).toHaveURL(/\/anmelden$/);
    await expect(page.locator('.shell')).toHaveCount(0);

    await context.close();
  });

  test('AC5: Sperren löscht den persistierten DEK — nach dem nächsten Login verlangt das Journal wieder die Passphrase', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);

    await setUpJournal(page, PASSPHRASE);

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await nav.getByRole('link', { name: 'Übersicht' }).click();
    await page.waitForURL('**/uebersicht');
    await page.getByRole('link', { name: 'Einstellungen' }).click();
    await expect(page).toHaveURL(/\/einstellungen$/);

    const toggle = page.getByRole('switch', { name: 'Auf diesem Gerät entsperrt lassen' });
    await toggle.click();
    await expect
      .poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek()))
      .toBe(true);

    await lock(page);

    await addThrowawayCookie(context, baseURL);

    await page.goto('/journal');
    await expect(page.locator('.journal-gate[data-state="locked"]')).toBeVisible();
    expect(await journalKeyRowCount()).toBe(1);

    await context.close();
  });

  test('AC7: eine offline angelegte Aufgabe bleibt nach Sperren, erneuter Anmeldung und Sync erhalten', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshSessionContext(browser, baseURL);
    await page.goto('/uebersicht');
    // Drains the boot-time Journal-habit mutation (helpers.ts settleJournalHabitBoot)
    // before the route block goes up below — otherwise JournalHabitBoot's own
    // `ensureJournalHabit()` can land its mutation in the outbox at an
    // unpredictable point and throw off the exact-size assertions that follow.
    await settleJournalHabitBoot(page);

    // Blocks sync for the whole cycle so the outbox can only ever drain when this
    // spec explicitly asks for it — otherwise the app's own 'online' listener
    // (src/local/sync.ts:274) races the assertions below.
    await page.route('**/api/sync/**', (route) => route.abort('failed'));

    await context.setOffline(true);
    await page.evaluate(() =>
      window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Trotz Sperren da' },
      }),
    );
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

    await context.setOffline(false);

    await page.goto('/einstellungen');
    await lock(page);

    await addThrowawayCookie(context, baseURL);
    await page.goto('/uebersicht');

    expect(await page.evaluate(() => window.__starship.size())).toBe(1);

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const result = await withDb((client) =>
      client.query('SELECT count(*)::int AS n FROM tasks WHERE title = $1', [
        'Trotz Sperren da',
      ]),
    );
    expect(result.rows[0].n).toBe(1);

    await context.close();
  });
});
