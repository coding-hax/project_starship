import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PULL_PAGE_LIMIT } from '@/local/conflict';
import {
  FIXED_NOW,
  freezeClock,
  openSecondDevice,
  registerPasskey,
  resetAppData,
  selectView,
  settleJournalHabitBoot,
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
  await resetAppData();
});

/**
 * The M0 acceptance criterion, end to end:
 * a mutation made without a network survives a reload and reaches Postgres once
 * the connection is back. If this breaks, local-first is a lie.
 */
test('a mutation made offline survives a reload and reaches Postgres', async ({ page }) => {
  await registerPasskey(page);
  await settleJournalHabitBoot(page);

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

  // The reload just remounted SyncBoot, whose mount effect fires its own sync()
  // against the still-aborted route (see the #528 test above). Let that attempt
  // fail and settle here, while the route is still active — unrouting while it is
  // still in flight would let its request land exactly in the teardown window and
  // hang forever instead of failing (issue #120: same race, a different automatic
  // trigger).
  await page.evaluate(() => window.__starship.sync());

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

// The point of this one is the *absence* of a session, so it opts out of the shared
// owner state the `setup` project hands to every project (#115).
test.describe('ohne Session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the sync endpoints reject a request without a session', async ({ request }) => {
    const push = await request.post('/api/sync/push', { data: { mutations: [] } });
    expect(push.status()).toBe(401);

    const pull = await request.get('/api/sync/pull');
    expect(pull.status()).toBe(401);
  });
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
    await selectView(page, 'Alle');

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
    await selectView(page, 'Alle');

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
    await selectView(page, 'Alle');

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

    await expect(page.getByText('Sollte nicht erscheinen, Tab ist versteckt')).not.toBeVisible();
    await devicePage.close();
  });

  test('overlapping triggers coalesce into a single pull, not one per trigger', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);
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

  /**
   * AK1 (#528): a caller docking onto an in-flight sync must not be served a pull
   * that started before its own call — even when its outbox is empty, which is the
   * exact condition the old single-`rerun`-flag coalescing dropped (`sync.ts:36`
   * pre-fix, the Garmin flake in `garmin.spec.ts:130`). Deterministic, no timers:
   * the mount pull is held via `route.fetch()` + a manual gate so the docking call
   * provably lands *during* that pull, not before or after it.
   */
  test('a caller that docks mid-pull gets a pull that started after its own call, even with an empty outbox (AK1, #528)', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    let pullCount = 0;
    let signalFirstPullFetched: () => void = () => {};
    const firstPullFetched = new Promise<void>((resolve) => {
      signalFirstPullFetched = resolve;
    });
    let releaseFirstPull: () => void = () => {};
    const firstPullHeld = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });

    await page.route('**/api/sync/pull**', async (route) => {
      pullCount++;
      if (pullCount !== 1) {
        await route.continue();
        return;
      }
      // Captures the server's answer now — before device B's row exists — so the
      // response held below is provably the stale, pre-insert one.
      const response = await route.fetch();
      signalFirstPullFetched();
      await firstPullHeld;
      await route.fulfill({ response });
    });

    // Remounts SyncBoot, whose mount effect calls the one sync() this test holds.
    await page.reload();
    await firstPullFetched;

    const devicePage = await openSecondDevice(browser, page);
    const title = 'Nach dem Andocken angekommen';
    await createTaskOnDevice(devicePage, title);

    // Not awaited yet — this call must dock onto the still-held mount sync.
    const probe = page.evaluate(async (expectedTitle) => {
      const p = window.__starship.sync(); // docks -> sets both rerun flags synchronously
      (window as unknown as { __coalesced?: boolean }).__coalesced = true;
      await p;
      const rows = await window.__starship.debugRecords();
      return rows.some(
        (r) => r.table === 'tasks' && (r.data as { title?: string }).title === expectedTitle,
      );
    }, title);

    // Proves the dock happened before release, i.e. while the first pull was still
    // in flight — otherwise this would be racing against sync()'s own coalescing.
    await page.waitForFunction(
      () => (window as unknown as { __coalesced?: boolean }).__coalesced === true,
    );
    releaseFirstPull();

    expect(await probe).toBe(true);
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.__starship.size())).toBe(0);
    await devicePage.close();
  });

  test('an interval tick without a connection does not throw, the next tick still syncs', async ({
    page,
    browser,
  }) => {
    await page.clock.install();
    await registerPasskey(page);
    await page.goto('/aufgaben');
    await selectView(page, 'Alle');

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
      await window.__starship.mutate({
        table: 'tasks',
        rowId: id,
        op: 'upsert',
        payload: { title: t },
      });
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

    const rowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Original' },
      });
      await window.__starship.sync();
      return id;
    });

    const devicePage = await openSecondDevice(browser, page);
    // Pull the original row first, so device B's edit carries the correct baseSeq.
    await devicePage.evaluate(async () => {
      await fetch('/api/sync/pull?since=0');
    });
    await devicePage.evaluate(() => window.__starship.sync());

    const warnings: string[] = [];
    devicePage.on('console', (msg) => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    // A arrives first, with a normal clock.
    await editTaskOnDevice(page, rowId, 'Von A, aktuelle Uhr');

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

    // Case 1: delete, then restore — undo wins because it arrives last.
    const deletedRowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'A' },
      });
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
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'B' },
      });
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
    await selectView(page, 'Alle');

    // Establish a baseline so device B's cursor is not simply "start of time".
    await page.evaluate(async () => {
      await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Normal, aktuelle Uhr' },
      });
      await window.__starship.sync();
    });

    const devicePage = await openSecondDevice(browser, page);
    await devicePage.goto('/aufgaben');
    await selectView(devicePage, 'Alle');
    await expect(devicePage.getByText('Normal, aktuelle Uhr')).toBeVisible();

    // Device A's clock now looks ten years in the past. Under the old
    // timestamp-based pull cursor this row would compare "older" than device
    // B's last-pulled timestamp and never be fetched.
    await skewClock(page, '2016-01-01T00:00:00Z');
    await page.evaluate(async () => {
      await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Rückdatiert' },
      });
      await window.__starship.sync();
    });

    await devicePage.evaluate(() => window.__starship.sync());
    await expect(devicePage.getByText('Rückdatiert')).toBeVisible();

    await devicePage.close();
  });
});

/**
 * #479 — a row skipped during pull because a local mutation for it was still
 * queued used to let the cursor advance past it anyway. If that mutation was
 * later discarded (e.g. rejected as malformed), the skipped server version was
 * never pulled again — a silent, self-perpetuating divergence.
 */
test.describe('Cursor überspringt nie dauerhaft eine wartende Zeile (#479)', () => {
  test('AK1+AK2: die übersprungene Änderung wird nachgeholt, sobald die wartende Mutation verworfen wird', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);

    // Device A creates row R, synced to Postgres.
    const rowId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Ursprung' },
      });
      await window.__starship.sync();
      return id;
    });

    // Device B pulls R, then edits it — the server state for R advances past
    // what A has seen so far.
    const deviceB = await openSecondDevice(browser, page);
    await deviceB.evaluate(() => window.__starship.sync());
    await editTaskOnDevice(deviceB, rowId, 'Von B');

    const serverAfterB = await withDb((c) =>
      c.query('SELECT sync_seq FROM tasks WHERE id = $1', [rowId]),
    );
    // node-postgres returns bigint (int8) columns as strings, not numbers, to
    // avoid silent precision loss — Number() here mirrors what Drizzle's
    // `bigint(..., { mode: 'number' })` does for every other reader of this column.
    const seqAfterB: number = Number(serverAfterB.rows[0].sync_seq);

    // Device A: block push only, then mutate R locally so a mutation for it sits
    // in the outbox — the following pull must skip B's version of R because A's
    // own write is still queued.
    await page.route('**/api/sync/push', (route) => route.abort('failed'));
    await page.evaluate(
      (id) =>
        window.__starship.mutate({
          table: 'tasks',
          rowId: id,
          op: 'upsert',
          payload: { title: 'Von A, wartet' },
        }),
      rowId,
    );
    await page.evaluate(() => window.__starship.sync());

    // The skip happened: A's cursor must not have advanced past B's write, and
    // A's local row must still show its own pending edit, not B's.
    const metaAfterSkip = await page.evaluate(() => window.__starship.debugMeta());
    const cursorAfterSkip = metaAfterSkip.find((m) => m.key === 'lastPulledSeq')?.value as number;
    expect(cursorAfterSkip).toBeLessThan(seqAfterB);

    const recordsAfterSkip = await page.evaluate(() => window.__starship.debugRecords());
    expect(recordsAfterSkip.find((r) => r.id === rowId)?.data.title).toBe('Von A, wartet');

    // Release push, then corrupt A's queued mutation so the server rejects it as
    // malformed — discardStale drops it, freeing R for the next pull to re-fetch.
    await page.unroute('**/api/sync/push');
    await page.evaluate(async (id) => {
      const entries = await window.__starship.pending();
      const entry = entries.find((e) => e.rowId === id);
      if (!entry) throw new Error('outbox entry not found');
      await window.__starship.debugPatchOutbox(entry.id, { updatedAt: 42 });
    }, rowId);

    await page.evaluate(() => window.__starship.sync());

    // R now shows B's version, not A's discarded one — the cursor clamp let the
    // skipped change be re-delivered instead of staying stuck behind it forever.
    const recordsAfterHeal = await page.evaluate(() => window.__starship.debugRecords());
    expect(recordsAfterHeal.find((r) => r.id === rowId)?.data.title).toBe('Von B');

    await deviceB.close();
  });
});

/**
 * M2 foundation (#101) — data model only, no UI. Mirrors the sync_state offline
 * test above: the outbox does not know or care what table it is carrying.
 */
test.describe('Routinen: Datenmodell + Sync (#101)', () => {
  test('a habit and a log created offline reach Postgres with a sync_seq once online', async ({
    page,
  }) => {
    await registerPasskey(page);
    // Settle the boot-created Journal habit (issue #505 AC1) *before* going offline —
    // it must reach Postgres first, or the row-count assertions below would count
    // it as part of this test's own offline batch.
    await settleJournalHabitBoot(page);

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

    // Just the already-synced Journal habit — this test's own habit is still offline.
    const beforeSync = await withDb((c) => c.query('SELECT * FROM habits'));
    expect(beforeSync.rowCount).toBe(1);

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
      c.query(
        'SELECT habit_id, log_date::text AS log_date, done, sync_seq FROM habit_logs WHERE id = $1',
        [logId],
      ),
    );
    expect(logRow.rowCount).toBe(1);
    expect(logRow.rows[0].habit_id).toBe(habitId);
    // `::text` avoids `pg`'s automatic `date` → local-midnight `Date` parsing — that
    // conversion, not the stored value, is what would shift the calendar day in a
    // timezone east of UTC (e.g. Europe/Berlin in summer).
    expect(logRow.rows[0].log_date).toBe('2026-07-15');
    expect(logRow.rows[0].done).toBe(true);
    expect(logRow.rows[0].sync_seq).not.toBeNull();
  });

  test('habit_logs enforces UNIQUE(habit_id, log_date) at the database level', async ({ page }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

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

/**
 * #183 — N+1 query optimization: the outbox is read once per pull, not N times.
 * Behavior unchanged: locally queued changes are never overwritten by incoming pull data.
 */
test.describe('N+1 Abfrage beseitigen: Outbox einmal statt pro Änderung (#183)', () => {
  test('AC2: eine gequeute Änderung wird nicht durch Pull-Daten überschrieben', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');

    // Create a task and sync it to establish a baseline (syncSeq = 1)
    const taskId = await page.evaluate(async () => {
      const id = await window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Initial version' },
      });
      await window.__starship.sync();
      return id;
    });
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // Make a local change (stays in the outbox, baseSeq = 1)
    await page.evaluate(
      (id) =>
        window.__starship.mutate({
          table: 'tasks',
          rowId: id,
          op: 'upsert',
          payload: { title: 'Local change, not yet synced' },
        }),
      taskId,
    );
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

    // Block the push endpoint so the outbox doesn't get cleared
    await page.route('**/api/sync/push', (route) => route.abort('failed'));

    // Mock a pull response with a competing change (syncSeq = 2, newer)
    const pullResponse = {
      changes: [
        {
          table: 'tasks',
          id: taskId,
          updatedAt: new Date(FIXED_NOW).toISOString(),
          deletedAt: null,
          syncSeq: 2, // Newer than the local record's syncSeq (1)
          data: { title: 'Change from another device' },
        },
      ],
      cursor: 2,
    };

    await page.route('**/api/sync/pull**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(pullResponse),
      });
    });

    // Trigger a sync (push will fail/abort, then pull will run)
    await page.evaluate(() => window.__starship.sync());

    // The local change should still be in the outbox (push failed)
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(1);

    // The local record should NOT have been overwritten by the pull —
    // a queued mutation prevents the overwrite (ADR-0001).
    const localData = await page.evaluate(async (id) => {
      const local = await (
        window.__starship as unknown as {
          debugRecords: () => Promise<
            Array<{
              id: string;
              table: string;
              data: Record<string, unknown>;
              syncSeq: number | null;
            }>
          >;
        }
      ).debugRecords();
      return local.find((r) => r.id === id);
    }, taskId);
    // Critical check: the local change must not be overwritten
    expect(localData?.data.title).toBe('Local change, not yet synced');
  });
});

/**
 * #182 — a single poison mutation used to fail the whole batch with a 400,
 * wedging every valid mutation behind it in the outbox forever.
 */
test.describe('eine kaputte Mutation blockiert die Outbox nicht mehr (#182)', () => {
  test('AC1: 1 malformed + 3 gültige Mutationen — die gültigen landen in Postgres, die malformed wird verworfen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const validTitles = ['Gültig 1', 'Gültig 2', 'Gültig 3'];
    for (const title of validTitles) {
      await page.evaluate(
        (t) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: t } }),
        title,
      );
    }

    const malformedRowId = await page.evaluate(() =>
      window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: 'Kaputt' } }),
    );
    // A wire-format bug or storage damage, not something `mutate()` can produce
    // itself — corrupt the entry after the fact to reproduce a poison mutation.
    await page.evaluate(async (rowId) => {
      const entries = await window.__starship.pending();
      const entry = entries.find((e) => e.rowId === rowId);
      if (!entry) throw new Error('outbox entry not found');
      await window.__starship.debugPatchOutbox(entry.id, { rowId: 42 });
    }, malformedRowId);

    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(4);

    await page.evaluate(() => window.__starship.sync());

    // The malformed mutation is gone from the queue too — discardStale ran.
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const rows = await withDb((c) => c.query('SELECT title FROM tasks ORDER BY title'));
    expect(rows.rows.map((r) => r.title)).toEqual([...validTitles].sort());
  });

  test('AC2: nach 5 Server-Fehlschlägen in Folge wird ein Sync-Fehlerhinweis sichtbar', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);
    await page.goto('/aufgaben');

    await page.evaluate(() =>
      window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Bleibt hängen' },
      }),
    );

    await page.route('**/api/sync/push', (route) => route.fulfill({ status: 500, body: '{}' }));

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__starship.sync());
    }

    // Not getByRole('alert') — Next's route announcer also has role="alert" and
    // would make this a strict-mode violation regardless of the sync outcome.
    await expect(page.getByText('Änderungen konnten nicht synchronisiert werden.')).toBeVisible();
  });

  test('AC3: ein Offline-Fehlschlag zählt nicht zum Fehler-Cap — kein Hinweis, die Queue überlebt', async ({
    page,
  }) => {
    await registerPasskey(page);
    await page.goto('/aufgaben');
    await settleJournalHabitBoot(page);

    await page.evaluate(() =>
      window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Offline hängt fest' },
      }),
    );

    await page.route('**/api/sync/push', (route) => route.abort('failed'));

    // More than SYNC_ERROR_THRESHOLD attempts — if offline counted the same as a
    // server failure this would have tripped the error hint by now.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.__starship.sync());
    }

    await expect(page.getByText('Änderungen konnten nicht synchronisiert werden.')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBeGreaterThan(0);
  });
});

/**
 * #474 — a DB constraint violation (not one the handler catches itself, e.g.
 * `habit_logs`' `UNIQUE(habit_id, log_date)`) used to abort the whole push
 * transaction with a 500, wedging every mutation behind it in the outbox forever.
 * Each write now runs in its own savepoint, so only the poisoned mutation is
 * dropped (`reason: 'constraint'`) — the rest of the batch still lands.
 */
test.describe('eine DB-Constraint-Verletzung wedged die Outbox nicht (#474)', () => {
  test('AK1+AK2: die vergiftete Mutation wird verworfen, der Rest desselben Batches kommt trotzdem an', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Laufen', schedule: 'daily' },
      }),
    );
    await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-02', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // Queue a valid task and a *second* log for the same habit + day while offline,
    // so both land in the same push batch. The second log has no rowId — it is a new
    // row, so it collides with the habit_logs UNIQUE(habit_id, log_date) index.
    await page.route('**/api/sync/**', (route) => route.abort('failed'));
    await page.evaluate(() =>
      window.__starship.mutate({
        table: 'tasks',
        op: 'upsert',
        payload: { title: 'Sollte trotzdem ankommen' },
      }),
    );
    await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-02', done: true },
        }),
      habitId,
    );
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(2);

    await page.unroute('**/api/sync/**');
    await page.evaluate(() => window.__starship.sync());

    // The poisoned log is dropped (discardStale) instead of retried forever, and it
    // did not hold up the task behind it.
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);
    await expect(page.getByText('Änderungen konnten nicht synchronisiert werden.')).toHaveCount(0);

    const taskRows = await withDb((c) =>
      c.query("SELECT id FROM tasks WHERE title = 'Sollte trotzdem ankommen'"),
    );
    expect(taskRows.rowCount).toBe(1);

    const logRows = await withDb((c) =>
      c.query('SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-02',
      ]),
    );
    expect(logRows.rowCount).toBe(1);
  });

  test('AK4: zwei Geräte loggen dieselbe Routine am selben Tag offline — Bs Outbox bleibt nicht hängen', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Meditieren', schedule: 'daily' },
      }),
    );
    await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-02', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const devicePage = await openSecondDevice(browser, page);
    // Pull A's habit + log first, so B knows about the day before it logs its own.
    await devicePage.evaluate(() => window.__starship.sync());

    // B logs the same habit on the same day offline — no rowId, so it is a new row
    // and collides with the same UNIQUE(habit_id, log_date) index as Test A above.
    await devicePage.route('**/api/sync/**', (route) => route.abort('failed'));
    await devicePage.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-02', done: true },
        }),
      habitId,
    );
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(1);

    await devicePage.unroute('**/api/sync/**');
    await devicePage.evaluate(() => window.__starship.sync());

    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(0);
    await expect(
      devicePage.getByText('Änderungen konnten nicht synchronisiert werden.'),
    ).toHaveCount(0);

    // Exactly one row survives for (habitId, 2026-08-02) — B's duplicate upserts onto
    // A's existing row by natural key instead of colliding with it (#475); this savepoint
    // path stays the net for the DB-constraint triggers #475 does not intercept (reminder_sends,
    // FK, a malformed date). B's local view of its own log is displaced under B's own uuid
    // between push() and the pull() that follows inside the same sync() call (sync.ts:35-36) —
    // that pull sweeps the displaced row out (see "Konvergenz" describe block below, #475/#502.
    // Only if that pull itself fails does the displaced row outlive this sync() call; the next
    // successful sync() still clears it (covered separately, #502).
    const logRows = await withDb((c) =>
      c.query('SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-02',
      ]),
    );
    expect(logRows.rowCount).toBe(1);

    await devicePage.close();
  });
});

/**
 * #475 — two devices offline each mint their own uuid for the same natural key
 * (`(habitId, logDate)`). The server now upserts onto the row that arrived first
 * instead of letting the second insert collide with the table's `uniqueIndex`
 * (that collision is what #474 above turns into a harmless `reason: 'constraint'`
 * rejection when it does happen elsewhere).
 */
test.describe('Konvergenz auf den natürlichen Schlüssel statt Kollision (#475)', () => {
  test('AK1: zwei eigene uuids für denselben (habitId, logDate) konvergieren auf die zuerst angekommene Zeile, die spätere Ankunft gewinnt bei done', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Meditieren', schedule: 'daily' },
      }),
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // "Device A": the first uuid for this (habitId, logDate), done:true, synced.
    const idA = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-04', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // "Device B": its own, distinct uuid for the very same day, done:false.
    const idB = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-04', done: false },
        }),
      habitId,
    );
    expect(idB).not.toBe(idA);
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // Exactly one row on the server, under A's id (arrived first), carrying B's
    // (later-arriving) `done` value — arrival order decides, not creation order.
    const logRows = await withDb((c) =>
      c.query('SELECT id, done FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-04',
      ]),
    );
    expect(logRows.rowCount).toBe(1);
    expect(logRows.rows[0].id).toBe(idA);
    expect(logRows.rows[0].done).toBe(false);

    // AK3: the pull that followed the push swept B's now-displaced local row out of
    // IndexedDB too — the store never shows the same day twice.
    const records = await page.evaluate(() => window.__starship.debugRecords());
    const logRecords = records.filter(
      (r) =>
        r.table === 'habit_logs' && r.data.habitId === habitId && r.data.logDate === '2026-08-04',
    );
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0].id).toBe(idA);
  });

  test('AK2: zwei eigene uuids für denselben (habitId, logDate) konvergieren auf eine Zeile mit gestiegenem sync_seq, auch bei gleichem done', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Laufen', schedule: 'daily' },
      }),
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const idA = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-05', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const logRowsAfterA = await withDb((c) =>
      c.query('SELECT sync_seq FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-05',
      ]),
    );
    expect(logRowsAfterA.rowCount).toBe(1);
    const syncSeqAfterA = Number(logRowsAfterA.rows[0].sync_seq);

    // "Device B": its own, distinct uuid for the very same day, the very same
    // `done` value — proving even an identical-looking payload still lands as
    // a real update on A's row, not a silently dropped no-op.
    const idB = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-05', done: true },
        }),
      habitId,
    );
    expect(idB).not.toBe(idA);
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // Still exactly one row, same id as before — but its sync_seq climbed, proving
    // B's mutation landed as an update on A's row rather than being silently dropped.
    const logRowsAfterB = await withDb((c) =>
      c.query('SELECT id, sync_seq FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-05',
      ]),
    );
    expect(logRowsAfterB.rowCount).toBe(1);
    expect(logRowsAfterB.rows[0].id).toBe(idA);
    expect(Number(logRowsAfterB.rows[0].sync_seq)).toBeGreaterThan(syncSeqAfterA);
  });

  test('AK3 (#502): zwei echte Geräte konvergieren nach einem einzigen sync() auch lokal auf eine Zeile', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Meditieren', schedule: 'daily' },
      }),
    );
    const idA = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-05', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const devicePage = await openSecondDevice(browser, page);
    // Pull A's habit + log first, so B knows about the day before it logs its own.
    await devicePage.evaluate(() => window.__starship.sync());

    // B logs the same habit on the same day offline — its own, distinct uuid.
    await devicePage.route('**/api/sync/**', (route) => route.abort('failed'));
    const idB = await devicePage.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-05', done: true },
        }),
      habitId,
    );
    expect(idB).not.toBe(idA);
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(1);

    await devicePage.unroute('**/api/sync/**');
    // A single sync() — push (upserts onto A's row by natural key) then pull (sweeps
    // B's now-displaced local row) run back to back inside it (sync.ts:35-36).
    await devicePage.evaluate(() => window.__starship.sync());
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(0);

    const serverRows = await withDb((c) =>
      c.query('SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-05',
      ]),
    );
    expect(serverRows.rowCount).toBe(1);
    expect(serverRows.rows[0].id).toBe(idA);

    // The part AK4 above never checked: B's own local store, not just the server.
    const records = await devicePage.evaluate(() => window.__starship.debugRecords());
    const logRecords = records.filter(
      (r) =>
        r.table === 'habit_logs' && r.data.habitId === habitId && r.data.logDate === '2026-08-05',
    );
    expect(logRecords).toHaveLength(1);
    expect(logRecords[0].id).toBe(idA);

    await devicePage.close();
  });

  test('AK4 (#502): scheitert der Pull nach erfolgreichem Push, überlebt die verdrängte lokale Zeile bis zum nächsten erfolgreichen sync()', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const habitId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'habits',
        op: 'upsert',
        payload: { name: 'Meditieren', schedule: 'daily' },
      }),
    );
    const idA = await page.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-06', done: true },
        }),
      habitId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const devicePage = await openSecondDevice(browser, page);
    await devicePage.evaluate(() => window.__starship.sync());

    const idB = await devicePage.evaluate(
      (hId) =>
        window.__starship.mutate({
          table: 'habit_logs',
          op: 'upsert',
          payload: { habitId: hId, logDate: '2026-08-06', done: true },
        }),
      habitId,
    );
    expect(idB).not.toBe(idA);

    // Push goes through — the server already upserts onto A's row (#475) — but the
    // pull that would sweep B's now-displaced local row fails (connection dropped
    // right after, not offline before): sync.ts:128 catches it and returns quietly,
    // no exception, no retry within this call.
    await devicePage.route('**/api/sync/pull**', (route) => route.abort('failed'));
    await devicePage.evaluate(() => window.__starship.sync());
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(0);

    const serverRowsAfterFailedPull = await withDb((c) =>
      c.query('SELECT id FROM habit_logs WHERE habit_id = $1 AND log_date = $2', [
        habitId,
        '2026-08-06',
      ]),
    );
    // The server already converged on A's row — the push succeeded independently
    // of the pull that failed afterwards.
    expect(serverRowsAfterFailedPull.rowCount).toBe(1);
    expect(serverRowsAfterFailedPull.rows[0].id).toBe(idA);

    const recordsAfterFailedPull = await devicePage.evaluate(() =>
      window.__starship.debugRecords(),
    );
    const logRecordsAfterFailedPull = recordsAfterFailedPull.filter(
      (r) =>
        r.table === 'habit_logs' && r.data.habitId === habitId && r.data.logDate === '2026-08-06',
    );
    // B still shows two local rows for the same day — its own displaced one never
    // got swept, because the pull that does the sweeping never landed.
    expect(logRecordsAfterFailedPull).toHaveLength(2);

    // The next sync() that actually gets to pull cleans it up — no data loss, no
    // permanent duplicate, just a window that outlives one failed sync() call.
    await devicePage.unroute('**/api/sync/pull**');
    await devicePage.evaluate(() => window.__starship.sync());

    const recordsAfterRecovery = await devicePage.evaluate(() => window.__starship.debugRecords());
    const logRecordsAfterRecovery = recordsAfterRecovery.filter(
      (r) =>
        r.table === 'habit_logs' && r.data.habitId === habitId && r.data.logDate === '2026-08-06',
    );
    expect(logRecordsAfterRecovery).toHaveLength(1);
    expect(logRecordsAfterRecovery[0].id).toBe(idA);

    await devicePage.close();
  });
});

test.describe('Serientermin-Ausnahmen: Konvergenz bei paralleler Verschiebung (#557 AC6)', () => {
  test('zwei Geräte verschieben dasselbe Vorkommen — eine Fassung gewinnt eindeutig, nichts geht kommentarlos verloren (ADR-0008)', async ({
    page,
    browser,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const eventId = await page.evaluate(() =>
      window.__starship.mutate({
        table: 'events',
        op: 'upsert',
        payload: {
          title: 'Yoga',
          allDay: false,
          startsAt: '2026-08-10T16:00:00.000Z',
          endsAt: '2026-08-10T17:00:00.000Z',
          recurrence: { freq: 'weekly', interval: 1 },
        },
      }),
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    const devicePage = await openSecondDevice(browser, page);
    // Pull the series onto B first, so both devices know the same occurrence.
    await devicePage.evaluate(() => window.__starship.sync());

    // A moves the occurrence to 19:00 Berlin and syncs — this row arrives first.
    const idA = await page.evaluate(
      (eId) =>
        window.__starship.mutate({
          table: 'event_exceptions',
          op: 'upsert',
          payload: {
            eventId: eId,
            originalDate: '2026-08-10',
            cancelled: false,
            overrideStartsAt: '2026-08-10T17:00:00.000Z',
            overrideEndsAt: '2026-08-10T18:00:00.000Z',
          },
        }),
      eventId,
    );
    await page.evaluate(() => window.__starship.sync());
    await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

    // B, independently offline, moves the very same occurrence to 20:00 — its own uuid.
    await devicePage.route('**/api/sync/**', (route) => route.abort('failed'));
    const idB = await devicePage.evaluate(
      (eId) =>
        window.__starship.mutate({
          table: 'event_exceptions',
          op: 'upsert',
          payload: {
            eventId: eId,
            originalDate: '2026-08-10',
            cancelled: false,
            overrideStartsAt: '2026-08-10T18:00:00.000Z',
            overrideEndsAt: '2026-08-10T19:00:00.000Z',
          },
        }),
      eventId,
    );
    expect(idB).not.toBe(idA);
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(1);

    await devicePage.unroute('**/api/sync/**');
    await devicePage.evaluate(() => window.__starship.sync());
    await expect.poll(() => devicePage.evaluate(() => window.__starship.size())).toBe(0);

    // Exactly one row on the server for this occurrence — A's id (arrived first,
    // #475's natural-key convergence), but B's later-arriving override wins on
    // content (ADR-0008, arrival order) — nothing silently dropped, no duplicate.
    const rows = await withDb((c) =>
      c.query(
        'SELECT id, override_starts_at FROM event_exceptions WHERE event_id = $1 AND original_date = $2',
        [eventId, '2026-08-10'],
      ),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(idA);
    expect(new Date(rows.rows[0].override_starts_at).toISOString()).toBe(
      '2026-08-10T18:00:00.000Z',
    );

    // A's own local view converges to the same winner once it syncs again.
    await page.evaluate(() => window.__starship.sync());
    const recordsA = await page.evaluate(() => window.__starship.debugRecords());
    const exceptionRecordsA = recordsA.filter(
      (r) =>
        r.table === 'event_exceptions' &&
        r.data.eventId === eventId &&
        r.data.originalDate === '2026-08-10',
    );
    expect(exceptionRecordsA).toHaveLength(1);
    expect(exceptionRecordsA[0].id).toBe(idA);

    await devicePage.close();
  });
});

test.describe('Pull-Pagination: der Erstsync kippt nicht mehr in einem Rutsch (fund F5, #478)', () => {
  /** Bulk-seeds `count` task rows directly in Postgres, each with its own sync_seq. */
  async function seedTasks(count: number, titlePrefix: string) {
    const result = await withDb((c) =>
      c.query(
        `INSERT INTO tasks (id, title, sync_seq)
         SELECT gen_random_uuid(), $1 || g, nextval('sync_seq')
         FROM generate_series(1, $2) AS g
         RETURNING id, sync_seq`,
        [titlePrefix, count],
      ),
    );
    return result.rows.map((r) => ({ id: r.id as string, syncSeq: Number(r.sync_seq) }));
  }

  test('AK2/AK3: der Client blättert bis zum Ende — vollständig, mehr als eine Anfrage nötig', async ({
    page,
  }) => {
    await registerPasskey(page);
    // Settle the boot-created Journal habit (issue #505 AC1) first — otherwise its
    // create mutation, still pending in the outbox, gets pushed interleaved with the
    // bulk-seeded tasks below and claims a sync_seq the `maxSeq` math doesn't expect.
    await settleJournalHabitBoot(page);

    const seeded = await seedTasks(PULL_PAGE_LIMIT + 50, 'Seed AK2 ');
    const maxSeq = Math.max(...seeded.map((r) => r.syncSeq));

    let pullRequests = 0;
    await page.route('**/api/sync/pull**', async (route) => {
      pullRequests++;
      await route.continue();
    });

    await page.evaluate(() => window.__starship.sync());

    // More than N+50 rows in one PULL_PAGE_LIMIT-capped response is impossible —
    // this alone proves more than one request was necessary.
    expect(pullRequests).toBeGreaterThan(1);

    const records = await page.evaluate(() => window.__starship.debugRecords());
    const taskIds = records.filter((r) => r.table === 'tasks').map((r) => r.id);
    // Every seeded row landed exactly once — nothing lost across the page boundary,
    // nothing duplicated.
    expect(new Set(taskIds)).toEqual(new Set(seeded.map((r) => r.id)));

    const meta = await page.evaluate(() => window.__starship.debugMeta());
    const cursor = meta.find((m) => m.key === 'lastPulledSeq')?.value;
    expect(cursor).toBe(maxSeq);
  });

  test('AK4: bricht der Erstsync zwischen zwei Seiten ab, setzt der nächste Sync fort statt neu zu beginnen', async ({
    page,
  }) => {
    await registerPasskey(page);
    await settleJournalHabitBoot(page);

    const seeded = await seedTasks(PULL_PAGE_LIMIT * 2 + 50, 'Seed AK4 ');
    const sortedSeqs = seeded.map((r) => r.syncSeq).sort((a, b) => a - b);
    const firstPageBoundary = sortedSeqs[PULL_PAGE_LIMIT - 1];
    const maxSeq = sortedSeqs[sortedSeqs.length - 1];

    // Let the first page through, then cut the network — the train-tunnel case.
    let pullCount = 0;
    await page.route('**/api/sync/pull**', async (route) => {
      pullCount++;
      if (pullCount === 2) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.evaluate(() => window.__starship.sync());

    const metaAfterAbort = await page.evaluate(() => window.__starship.debugMeta());
    const cursorAfterAbort = metaAfterAbort.find((m) => m.key === 'lastPulledSeq')?.value;
    // Neither 0 (a restart) nor the full history (the abort silently lost) — exactly
    // the boundary of the one page that landed before the network died.
    expect(cursorAfterAbort).toBe(firstPageBoundary);

    await page.unroute('**/api/sync/pull**');
    const sinceValues: number[] = [];
    await page.route('**/api/sync/pull**', async (route) => {
      sinceValues.push(Number(new URL(route.request().url()).searchParams.get('since')));
      await route.continue();
    });

    await page.evaluate(() => window.__starship.sync());

    // Resumes from the persisted boundary, not from 0 — no restart.
    expect(sinceValues[0]).toBe(firstPageBoundary);

    const records = await page.evaluate(() => window.__starship.debugRecords());
    const taskIds = records.filter((r) => r.table === 'tasks').map((r) => r.id);
    expect(new Set(taskIds)).toEqual(new Set(seeded.map((r) => r.id)));

    const metaFinal = await page.evaluate(() => window.__starship.debugMeta());
    const finalCursor = metaFinal.find((m) => m.key === 'lastPulledSeq')?.value;
    expect(finalCursor).toBe(maxSeq);
  });
});
