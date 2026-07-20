import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  freezeClock,
  openSecondDevice,
  registerPasskey,
  resetDatabase,
  skewClock,
  withDb,
} from './helpers';

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
    await freezeClock(page);
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

    await freezeClock(page);
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

    await freezeClock(page);
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

/** Edits an existing row on a device and pushes it — used to build arrival order. */
async function editTaskOnDevice(devicePage: Page, rowId: string, title: string) {
  await devicePage.evaluate(
    async ({ id, t }) => {
      await window.__starship.mutate({ table: 'tasks', rowId: id, op: 'upsert', payload: { title: t } });
      await window.__starship.sync();
    },
    { id: rowId, t: title },
  );
}

/**
 * ADR-0008 / #53: arrival at the server, not the client clock, decides sync
 * conflicts. These reproduce the exact failure mode ADR-0001's old
 * `updated_at`-based last-write-wins had — a clock-skewed device's write must
 * neither be silently rejected nor silently swallow another device's change.
 */
test.describe('Konfliktauflösung: Server-Sequence statt Client-Uhr (#53)', () => {
  test('a write from a clock skewed into the past still wins when it arrives last', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    page.on('request', (req) => {
      if (req.url().includes('/api/sync/push')) console.log('DEBUG A push req', req.postData());
    });
    page.on('response', async (res) => {
      if (res.url().includes('/api/sync/push')) console.log('DEBUG A push res', res.status(), await res.text());
    });

    const rowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Original' },
      });
      await window.__starship.sync();
      return id;
    });
    console.log('DEBUG rowId returned', rowId);

    const afterCreate = await withDb((c) => c.query('SELECT id, title, sync_seq FROM tasks'));
    console.log('DEBUG all tasks after A create+sync', JSON.stringify(afterCreate.rows));

    const devicePage = await openSecondDevice(browser, page);
    // Pull the original row first, so device B's edit carries the correct baseSeq.
    const pullResult = await devicePage.evaluate(async () => {
      const res = await fetch('/api/sync/pull?since=0');
      return { status: res.status, body: await res.text() };
    });
    console.log('DEBUG B raw pull', JSON.stringify(pullResult));
    await devicePage.evaluate(() => window.__starship.sync());

    const warnings: string[] = [];
    devicePage.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });
    devicePage.on('request', (req) => {
      if (req.url().includes('/api/sync/push')) console.log('DEBUG push req', req.postData());
    });
    devicePage.on('response', async (res) => {
      if (res.url().includes('/api/sync/push')) console.log('DEBUG push res', await res.text());
    });

    // A arrives first, with a normal clock.
    await editTaskOnDevice(page, rowId, 'Von A, aktuelle Uhr');

    console.log('DEBUG B records before edit', JSON.stringify(await devicePage.evaluate(() => (window.__starship as unknown as { debugRecords: () => unknown }).debugRecords())));
    console.log('DEBUG B meta before edit', JSON.stringify(await devicePage.evaluate(() => (window.__starship as unknown as { debugMeta: () => unknown }).debugMeta())));

    // B arrives second, but its clock is skewed ten years into the past — under
    // the old updated_at comparison this write would have been rejected as
    // "stale" even though it is, in fact, the newer arrival.
    await skewClock(devicePage, '2016-01-01T00:00:00Z');
    await editTaskOnDevice(devicePage, rowId, 'Von B, verstellte Uhr');

    const result = await withDb((c) =>
      c.query('SELECT title, sync_seq FROM tasks WHERE id = $1', [rowId]),
    );
    // Last arrival wins, not the write with the "newer-looking" timestamp.
    expect(result.rows[0].title).toBe('Von B, verstellte Uhr');

    // Nothing vanished silently — the overwrite was reported (ADR-0001). The
    // console event arrives over its own CDP channel, slightly after the
    // `sync()` call above resolves — poll instead of asserting immediately.
    await expect.poll(() => warnings.some((w) => w.includes('overwrote'))).toBe(true);

    await devicePage.close();
  });

  test('delete beats a competing update, in both arrival orders', async ({ page, browser }) => {
    await registerPasskey(page);

    async function deleteThenUpdateOrUpdateThenDelete(deleteFirst: boolean) {
      const rowId = await page.evaluate(async () => {
        const id = await window.__starship.mutate({
          table: 'tasks',
          op: 'upsert',
          payload: { title: 'Wird gelöscht' },
        });
        await window.__starship.sync();
        return id;
      });

      const devicePage = await openSecondDevice(browser, page);
      await devicePage.evaluate(() => window.__starship.sync());

      if (deleteFirst) {
        await page.evaluate(
          (id) =>
            window.__starship
              .mutate({ table: 'tasks', rowId: id, op: 'delete' })
              .then(() => window.__starship.sync()),
          rowId,
        );
        await editTaskOnDevice(devicePage, rowId, 'Update nach Delete');
      } else {
        await editTaskOnDevice(devicePage, rowId, 'Update vor Delete');
        await page.evaluate(
          (id) =>
            window.__starship
              .mutate({ table: 'tasks', rowId: id, op: 'delete' })
              .then(() => window.__starship.sync()),
          rowId,
        );
      }

      const result = await withDb((c) =>
        c.query('SELECT deleted_at FROM tasks WHERE id = $1', [rowId]),
      );
      expect(result.rows[0].deleted_at, `deleteFirst=${deleteFirst}`).not.toBeNull();

      await devicePage.close();
    }

    // Order 1: delete arrives, then an update — tombstone-neutral upsert must
    // not resurrect the row.
    await deleteThenUpdateOrUpdateThenDelete(true);
    // Order 2: update arrives, then the delete — the row must still end deleted.
    await deleteThenUpdateOrUpdateThenDelete(false);
  });

  test('restore vs. a competing delete: whichever arrives last decides', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    page.on('response', async (res) => {
      if (res.url().includes('/api/sync/push')) console.log('DEBUG push res (page)', await res.text());
    });

    // Case 1: delete, then restore — undo wins because it arrives last.
    const deletedRowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'A' } });
      await window.__starship.mutate({ table: 'tasks', rowId: id, op: 'delete' });
      await window.__starship.sync();
      return id;
    });
    const deviceA = await openSecondDevice(browser, page);
    await deviceA.evaluate(() => window.__starship.sync());
    await deviceA.evaluate(
      (id) =>
        window.__starship
          .mutate({ table: 'tasks', rowId: id, op: 'restore' })
          .then(() => window.__starship.sync()),
      deletedRowId,
    );

    const restored = await withDb((c) =>
      c.query('SELECT deleted_at FROM tasks WHERE id = $1', [deletedRowId]),
    );
    expect(restored.rows[0].deleted_at).toBeNull();
    await deviceA.close();

    // Case 2: restore, then a competing delete — the later delete wins.
    const restoredRowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'B' } });
      await window.__starship.mutate({ table: 'tasks', rowId: id, op: 'delete' });
      await window.__starship.mutate({ table: 'tasks', rowId: id, op: 'restore' });
      await window.__starship.sync();
      return id;
    });
    const deviceB = await openSecondDevice(browser, page);
    await deviceB.evaluate(() => window.__starship.sync());
    await deviceB.evaluate(
      (id) =>
        window.__starship
          .mutate({ table: 'tasks', rowId: id, op: 'delete' })
          .then(() => window.__starship.sync()),
      restoredRowId,
    );

    const deletedAgain = await withDb((c) =>
      c.query('SELECT deleted_at FROM tasks WHERE id = $1', [restoredRowId]),
    );
    expect(deletedAgain.rows[0].deleted_at).not.toBeNull();
    await deviceB.close();
  });

  test('the pull cursor does not skip a row with a backdated client clock', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    // Establish a baseline so device B's cursor is not simply "start of time".
    await page.evaluate(async () => {
      await window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Normal, aktuelle Uhr' } });
      await window.__starship.sync();
    });

    const devicePage = await openSecondDevice(browser, page);
    await devicePage.goto('/aufgaben');
    await expect(devicePage.getByText('Normal, aktuelle Uhr')).toBeVisible();

    // Device A's clock now looks ten years in the past. Under the old
    // timestamp-based pull cursor this row would compare "older" than device
    // B's last-pulled timestamp and never be fetched.
    await skewClock(page, '2016-01-01T00:00:00Z');
    await page.evaluate(async () => {
      await window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Rückdatiert' } });
      await window.__starship.sync();
    });

    await devicePage.evaluate(() => window.__starship.sync());
    await expect(devicePage.getByText('Rückdatiert')).toBeVisible();

    await devicePage.close();
  });
});

/**
 * M2 foundation (#101) — data model only, no UI. Mirrors the sync_state offline
 * test above: the outbox does not know or care what table it is carrying.
 */
test.describe('Gewohnheiten: Datenmodell + Sync (#101)', () => {
  test('a habit and a log created offline reach Postgres with a sync_seq once online', async ({
    page,
  }) => {
    await registerPasskey(page);

    await page.route('**/api/sync/**', (route) => route.abort('failed'));

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Meditieren', schedule: 'daily' },
      }),
    );
    const logId = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-07-15', done: true },
        }),
      habitId,
    );

    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

    const beforeSync = await withDb((c) => c.query('SELECT * FROM habits'));
    expect(beforeSync.rowCount).toBe(0);

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());

    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const habitRow = await withDb((c) =>
      c.query('SELECT name, schedule, sync_seq FROM habits WHERE id = $1', [habitId]),
    );
    expect(habitRow.rowCount).toBe(1);
    expect(habitRow.rows[0].name).toBe('Meditieren');
    expect(habitRow.rows[0].schedule).toBe('daily');
    expect(habitRow.rows[0].sync_seq).not.toBeNull();

    const logRow = await withDb((c) =>
      c.query('SELECT habit_id, log_date, done, sync_seq FROM habit_logs WHERE id = $1', [logId]),
    );
    expect(logRow.rowCount).toBe(1);
    expect(logRow.rows[0].habit_id).toBe(habitId);
    // Postgres returns a `date` column as a JS Date at UTC midnight via `pg` — compare
    // the calendar day, not the instant, so a non-UTC test runner cannot flake this.
    expect((logRow.rows[0].log_date as Date).toISOString().slice(0, 10)).toBe('2026-07-15');
    expect(logRow.rows[0].done).toBe(true);
    expect(logRow.rows[0].sync_seq).not.toBeNull();
  });

  test('habit_logs enforces UNIQUE(habit_id, log_date) at the database level', async ({ page }) => {
    await registerPasskey(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Laufen', schedule: 'daily' },
      }),
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // Two distinct rows (distinct ids, as two devices racing offline would produce)
    // for the same habit and calendar day. The whitelist/required-fields layer in
    // src/db/sync-tables.ts has no opinion on this — it is a database constraint.
    await withDb((c) =>
      c.query(
        'INSERT INTO habit_logs (id, sync_seq, habit_id, log_date, done) ' +
          "VALUES ($1, nextval('sync_seq'), $2, '2026-07-15', true)",
        [randomUUID(), habitId],
      ),
    );

    await expect(
      withDb((c) =>
        c.query(
          'INSERT INTO habit_logs (id, sync_seq, habit_id, log_date, done) ' +
            "VALUES ($1, nextval('sync_seq'), $2, '2026-07-15', true)",
          [randomUUID(), habitId],
        ),
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
