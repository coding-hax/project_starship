import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  createOtherAccount,
  createThrowawaySession,
  deleteAccount,
  registerPasskey,
  resetAppData,
  setAccountBlocked,
  settleJournalHabitBoot,
  withDb,
} from './helpers';

const PASSPHRASE = 'correct horse battery staple';

test.beforeEach(async () => {
  await resetAppData();
});

/** Mirrors `freshSessionContext` in auth-sperren.spec.ts:22 — a throwaway session
 * row, never the shared `AUTH_STATE` session, so this file's destructive flows
 * (logout, block, delete) never touch what other specs' `storageState` depends on. */
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

/** The account a `freshSessionContext`/`createThrowawaySession()` cookie resolves
 * to — always the admin account once a passkey ceremony has run (see
 * `ensureSessionAccount` in helpers.ts), which every spec file's shared setup
 * already guarantees. */
async function accountOf(tokenHash: string): Promise<string> {
  const result = await withDb((client) =>
    client.query('SELECT user_id FROM sessions WHERE token_hash = $1', [tokenHash]),
  );
  return result.rows[0].user_id as string;
}

/** Mirrors `setUpJournal` in auth-sperren.spec.ts:43/journal-lock.spec.ts:25. */
async function setUpJournal(page: Page, passphrase: string) {
  await registerPasskey(page, '/journal');
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Passphrase wiederholen').fill(passphrase);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await page.getByTestId('journal-recovery-key').waitFor();
  await page.getByRole('button', { name: 'Habe ich gespeichert' }).click();
  await page.locator('.journal-gate[data-state="unlocked"]').waitFor();
}

/**
 * Toggles "Auf diesem Gerät entsperrt lassen" and waits for the persisted DEK to
 * actually land — mirrors auth-sperren.spec.ts AC5. A client-side `Link` click,
 * not `page.goto('/einstellungen')`: a full navigation reloads the SPA and drops
 * `lock-store`'s in-memory DEK, so the toggle would find the journal `locked`
 * again and skip the persist (`onPersistPrefChange` only acts while `unlocked`).
 */
async function persistJournalDek(page: Page) {
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Übersicht' }).click();
  await page.waitForURL('**/uebersicht');
  await page.getByRole('link', { name: 'Einstellungen' }).click();
  await page.getByRole('switch', { name: 'Auf diesem Gerät entsperrt lassen' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__starship.journalHasPersistedDek()))
    .toBe(true);
}

async function dumpStores(page: Page): Promise<{
  records: Array<{ data?: Record<string, unknown> }>;
  meta: Array<{ key: string; value: unknown }>;
}> {
  return JSON.parse(await page.evaluate(() => window.__starship.debugDumpStores()));
}

async function seedAndPushTask(page: Page, title: string) {
  await page.evaluate(
    (taskTitle) =>
      window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: taskTitle } }),
    title,
  );
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
}

/**
 * Lets the post-wipe `window.location.assign('/anmelden')` redirect (sync.ts,
 * session-panel.tsx) actually land while the browser context is offline. The dev
 * server never ships a service worker (next.config.ts: `disable: NODE_ENV ===
 * 'development'`, see offline-critical.spec.ts) — a real offline navigation to a
 * route this context never visited fails outright with `ERR_INTERNET_DISCONNECTED`,
 * which is a dev-mode e2e gap, not a product one (every real account has visited
 * `/anmelden` at least once, to log in). The stub response's content is never
 * read — only that the navigation completes, so the local wipe below can still be
 * inspected afterwards.
 */
async function stubAnmeldenForOfflineRedirect(page: Page): Promise<void> {
  await page.route('**/anmelden', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>anmelden</title>' }),
  );
}

/**
 * Reads the local `records` store through a raw IndexedDB connection, not the
 * app's own Dexie handle — needed for AK6/AK7, where the assertion runs on
 * `/anmelden`, outside the `(app)` layout that mounts `E2EBridge`. Opening a
 * second Dexie connection while the app's own is still live is the documented
 * flake (journal.spec.ts #338 AC3); this never races that, since the app's
 * connection died with the hard navigation that got us here.
 */
async function localRecordCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('starship');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('records')) {
            db.close();
            resolve(0);
            return;
          }
          const countRequest = db.transaction('records', 'readonly').objectStore('records').count();
          countRequest.onsuccess = () => {
            db.close();
            resolve(countRequest.result);
          };
          countRequest.onerror = () => {
            db.close();
            reject(countRequest.error);
          };
        };
      }),
  );
}

test('AK1: /api/auth/status liefert die userId nur mit gültiger Sitzung', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshSessionContext(browser, baseURL);

  const withSession = await page.request.get('/api/auth/status');
  const bodyWithSession = await withSession.json();
  expect(bodyWithSession.authenticated).toBe(true);
  expect(typeof bodyWithSession.userId).toBe('string');

  // Plain `browser.newContext()` inherits the `mobile` project's AUTH_STATE
  // cookie (auth-rate-limit.spec.ts, auth-recovery-register.spec.ts) — an empty
  // storageState is what actually gets an anonymous context.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const withoutSession = await anonymous.request.get(`${baseURL}/api/auth/status`);
  const bodyWithoutSession = await withoutSession.json();
  expect(bodyWithoutSession.authenticated).toBe(false);
  expect(bodyWithoutSession.userId).toBeUndefined();

  await anonymous.close();
  await context.close();
});

test('AK2/AK3: Kontowechsel spült A komplett, bevor B läuft — geprüft über den Bridge-Dump', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshSessionContext(browser, baseURL);
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);

  await seedAndPushTask(page, 'A-Aufgabe');
  await setUpJournal(page, PASSPHRASE);
  await persistJournalDek(page);

  const other = await createOtherAccount();
  const sessionB = await createThrowawaySession(undefined, undefined, other.userId);
  await context.addCookies([{ name: 'starship_session', value: sessionB.token, url: baseURL }]);
  await page.reload();

  await expect
    .poll(async () => (await dumpStores(page)).meta.find((entry) => entry.key === 'accountId')?.value)
    .toBe(other.userId);
  await expect
    .poll(async () =>
      (await dumpStores(page)).records.some((row) => row.data?.title === other.titles.task),
    )
    .toBe(true);

  const dump = await dumpStores(page);
  expect(dump.records.some((row) => row.data?.title === 'A-Aufgabe')).toBe(false);
  expect(await page.evaluate(() => window.__starship.journalHasPersistedDek())).toBe(false);

  await context.close();
});

test('AK4: Abmelden und erneutes Anmelden desselben Kontos stellt den Zustand wieder her, nicht leer', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshSessionContext(browser, baseURL);
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);
  await seedAndPushTask(page, 'AK4-Aufgabe');

  await page.goto('/einstellungen');
  await page.getByRole('button', { name: 'App sperren' }).click();
  await page.getByRole('button', { name: 'Sperren' }).click();
  await page.waitForURL('**/anmelden');

  const relogin = await createThrowawaySession();
  await context.addCookies([{ name: 'starship_session', value: relogin.token, url: baseURL }]);
  await page.goto('/uebersicht');

  await expect
    .poll(async () => (await dumpStores(page)).records.some((row) => row.data?.title === 'AK4-Aufgabe'))
    .toBe(true);

  await context.close();
});

test('AK5: ein gesperrtes Konto zeigt die Sperrmeldung, behält seine Daten und synct nicht in einer Schleife', async ({
  browser,
  baseURL,
}) => {
  const { context, page, tokenHash } = await freshSessionContext(browser, baseURL);
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);
  await seedAndPushTask(page, 'AK5-Aufgabe');

  const userId = await accountOf(tokenHash);
  await setAccountBlocked(userId, true);

  let syncCalls = 0;
  await page.route('**/api/sync/**', (route) => {
    syncCalls += 1;
    return route.continue();
  });

  await page.evaluate(() => window.__starship.sync());
  await expect(
    page.getByText('Dieses Konto wurde gesperrt. Melde dich bei der Verwaltung.'),
  ).toBeVisible();
  const callsAfterFirstBlock = syncCalls;
  expect(callsAfterFirstBlock).toBeGreaterThan(0);

  // markBlocked() is cached (account-isolation.ts) — a later trigger never fetches
  // again, i.e. no retry loop, as long as the account stays blocked.
  await page.evaluate(() => window.__starship.sync());
  await page.evaluate(() => window.__starship.sync());
  expect(syncCalls).toBe(callsAfterFirstBlock);

  const dump = await dumpStores(page);
  expect(dump.records.some((row) => row.data?.title === 'AK5-Aufgabe')).toBe(true);

  await setAccountBlocked(userId, false);
  await context.close();
});

test('AK6: ein gelöschtes Konto räumt beim nächsten Sync lokal auf und landet auf /anmelden', async ({
  browser,
  baseURL,
}) => {
  const { context, page, tokenHash } = await freshSessionContext(browser, baseURL);
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);
  await seedAndPushTask(page, 'AK6-Aufgabe');

  const userId = await accountOf(tokenHash);
  await deleteAccount(userId);

  await page.evaluate(() => window.__starship.sync());
  await page.waitForURL('**/anmelden');

  expect(await localRecordCount(page)).toBe(0);

  await context.close();
});

test('AK7: ein Abmelden ohne Netz spült die lokale Datenbank trotzdem', async ({ browser, baseURL }) => {
  const { context, page } = await freshSessionContext(browser, baseURL);
  await page.goto('/uebersicht');
  await settleJournalHabitBoot(page);
  await seedAndPushTask(page, 'AK7-Aufgabe');
  await page.goto('/einstellungen');
  await stubAnmeldenForOfflineRedirect(page);

  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'App sperren' })).toBeEnabled();
  await page.getByRole('button', { name: 'App sperren' }).click();
  await page.getByRole('button', { name: 'Sperren' }).click();
  await page.waitForURL('**/anmelden');

  expect(await localRecordCount(page)).toBe(0);

  await context.setOffline(false);
  await context.close();
});
