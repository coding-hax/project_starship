import { expect, test, type Page } from '@playwright/test';
import { openSecondDevice, registerPasskey, resetDatabase, withDb } from './helpers';

// Mirrors PULL_INTERVAL_MS in src/local/sync.ts. Not imported — that module pulls
// in Dexie/IndexedDB bindings that do not resolve outside a browser context.
const PULL_INTERVAL_MS = 30_000;

/** Writes a task on another tab's own IndexedDB and pushes it to the server. */
async function createTaskOnDevice(devicePage: Page, title: string) {
  await devicePage.waitForFunction(() => typeof window.__starship?.mutate === 'function');
  await devicePage.evaluate(async (t) => {
    await window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: t } });
    await window.__starship.sync();
  }, title);
}

test.beforeEach(async () => {
  await resetDatabase();
});

/**
 * The M0 acceptance criterion, end to end:
 * a mutation made without a network survives a reload and reaches Postgres once
 * the connection is back. If this breaks, local-first is a lie.
 */
test('a mutation made offline survives a reload and reaches Postgres', async ({ page }) => {
  await registerPasskey(page);

  // Cut the sync endpoints. The page still serves, but nothing can be pushed —
  // which is exactly what a train tunnel looks like to the outbox.
  await page.route('**/api/sync/**', (route) => route.abort('failed'));

  const rowId = await page.evaluate(() =>
    window.__starship.mutate({
      table: 'sync_state',
      op: 'upsert',
      payload: { key: 'offline-probe', value: { source: 'train' } },
    }),
  );

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Nothing reached the server — that is the point.
  const beforeReload = await withDb((c) => c.query('SELECT * FROM sync_state'));
  expect(beforeReload.rowCount).toBe(0);

  // The queue lives in IndexedDB, not in a variable. Prove it.
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

  // Back online.
  await page.unroute('**/api/sync/**');
  await page.evaluate(() => window.__starship.sync());

  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const afterSync = await withDb((c) =>
    c.query('SELECT id, key, value FROM sync_state WHERE id = $1', [rowId]),
  );
  expect(afterSync.rowCount).toBe(1);
  expect(afterSync.rows[0].key).toBe('offline-probe');
  expect(afterSync.rows[0].value).toEqual({ source: 'train' });
});

test('a delete is a tombstone, never a hard delete', async ({ page }) => {
  await registerPasskey(page);

  const rowId = await page.evaluate(async () => {
    const id = await window.__starship.mutate({
      table: 'sync_state',
      op: 'upsert',
      payload: { key: 'doomed', value: { n: 1 } },
    });
    await window.__starship.sync();
    return id;
  });

  await page.evaluate(async (id) => {
    await window.__starship.mutate({ table: 'sync_state', rowId: id, op: 'delete' });
    await window.__starship.sync();
  }, rowId);

  // A hard delete would let the row resurrect on the next pull from another device.
  const result = await withDb((c) =>
    c.query('SELECT deleted_at FROM sync_state WHERE id = $1', [rowId]),
  );
  expect(result.rowCount).toBe(1);
  expect(result.rows[0].deleted_at).not.toBeNull();
});

test('the sync endpoints reject a request without a session', async ({ request }) => {
  const push = await request.post('/api/sync/push', { data: { mutations: [] } });
  expect(push.status()).toBe(401);

  const pull = await request.get('/api/sync/pull');
  expect(pull.status()).toBe(401);
});

/**
 * #29 — an already-open, focused tab used to only pull on load/reconnect/foreground.
 * A tab that is simply left open, visible, never backgrounded, never offline, never
 * got another device's changes until reloaded. These cover the fix: a visible-tab
 * interval, a `focus` pull, pausing while hidden, coalescing, offline safety, and
 * teardown.
 */
test.describe('offener Tab zieht periodisch und bei Fokus (#29)', () => {
  test('picks up a change from another device within the poll interval, no reload', async ({
    page,
    browser,
  }) => {
    await page.clock.install();
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const devicePage = await openSecondDevice(browser, page);
    await createTaskOnDevice(devicePage, 'Von Gerät B erstellt');

    // Freeze, then jump forward exactly one interval — deterministic, no real wait.
    await page.clock.pauseAt(Date.now());
    await page.clock.fastForward(PULL_INTERVAL_MS + 1_000);

    await expect(page.getByText('Von Gerät B erstellt')).toBeVisible();
    await devicePage.close();
  });

  test('a `focus` event pulls immediately, without waiting for the interval', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const devicePage = await openSecondDevice(browser, page);
    await createTaskOnDevice(devicePage, 'Von Gerät B, gesehen bei Fokus');

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(page.getByText('Von Gerät B, gesehen bei Fokus')).toBeVisible();
    await devicePage.close();
  });

  test('the poll interval pauses while the tab is hidden — no pull happens', async ({
    page,
    browser,
  }) => {
    await page.clock.install();
    await registerPasskey(page);
    await page.goto('/aufgaben');

    // A read-only property in real browsers; overriding it is the standard way to
    // simulate backgrounding without an actual second window.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const devicePage = await openSecondDevice(browser, page);
    await createTaskOnDevice(devicePage, 'Sollte nicht erscheinen, Tab ist versteckt');

    await page.clock.pauseAt(Date.now());
    // Several interval periods' worth of time — if the interval were still running,
    // this would have fired it several times over.
    await page.clock.fastForward(PULL_INTERVAL_MS * 3);

    await expect(
      page.getByText('Sollte nicht erscheinen, Tab ist versteckt'),
    ).not.toBeVisible();
    await devicePage.close();
  });

  test('overlapping triggers coalesce into a single pull, not one per trigger', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    let pullRequests = 0;
    await page.route('**/api/sync/pull**', async (route) => {
      pullRequests++;
      await route.continue();
    });

    // `online` and `focus` fire synchronously within the same dispatch call, before
    // either fetch has gone out — sync()'s `inFlight` coalescing (unchanged by this
    // fix) means the second call joins the first instead of starting its own.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });

    await expect.poll(() => pullRequests).toBe(1);
  });

  test('an interval tick without a connection does not throw, the next tick still syncs', async ({
    page,
    browser,
  }) => {
    await page.clock.install();
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.route('**/api/sync/**', (route) => route.abort('failed'));

    await page.clock.pauseAt(Date.now());
    await page.clock.fastForward(PULL_INTERVAL_MS + 1_000);

    expect(pageErrors).toEqual([]);

    await page.unroute('**/api/sync/**');

    const devicePage = await openSecondDevice(browser, page);
    await createTaskOnDevice(devicePage, 'Erscheint nach dem nächsten Tick');

    await page.clock.fastForward(PULL_INTERVAL_MS + 1_000);

    await expect(page.getByText('Erscheint nach dem nächsten Tick')).toBeVisible();
    await devicePage.close();
  });

  test('startSync tears down exactly the listeners and interval it set up', async ({ page }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    const counts = await page.evaluate(() => {
      let addedListeners = 0;
      let removedListeners = 0;
      let intervalsCreated = 0;
      let intervalsCleared = 0;

      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);
      const originalDocAdd = document.addEventListener.bind(document);
      const originalDocRemove = document.removeEventListener.bind(document);
      const originalSetInterval = window.setInterval.bind(window);
      const originalClearInterval = window.clearInterval.bind(window);

      window.addEventListener = new Proxy(originalWindowAdd, {
        apply(target, thisArg, args: Parameters<typeof originalWindowAdd>) {
          addedListeners++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      window.removeEventListener = new Proxy(originalWindowRemove, {
        apply(target, thisArg, args: Parameters<typeof originalWindowRemove>) {
          removedListeners++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      document.addEventListener = new Proxy(originalDocAdd, {
        apply(target, thisArg, args: Parameters<typeof originalDocAdd>) {
          addedListeners++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      document.removeEventListener = new Proxy(originalDocRemove, {
        apply(target, thisArg, args: Parameters<typeof originalDocRemove>) {
          removedListeners++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      window.setInterval = new Proxy(originalSetInterval, {
        apply(target, thisArg, args: Parameters<typeof originalSetInterval>) {
          intervalsCreated++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      window.clearInterval = new Proxy(originalClearInterval, {
        apply(target, thisArg, args: Parameters<typeof originalClearInterval>) {
          intervalsCleared++;
          return Reflect.apply(target, thisArg, args);
        },
      });

      const teardown = window.__starship.startSync();
      teardown();

      window.addEventListener = originalWindowAdd;
      window.removeEventListener = originalWindowRemove;
      document.addEventListener = originalDocAdd;
      document.removeEventListener = originalDocRemove;
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;

      return { addedListeners, removedListeners, intervalsCreated, intervalsCleared };
    });

    expect(counts.addedListeners).toBeGreaterThan(0);
    expect(counts.removedListeners).toBe(counts.addedListeners);
    expect(counts.intervalsCreated).toBe(1);
    expect(counts.intervalsCleared).toBe(counts.intervalsCreated);
  });
});
