import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase, withDb } from './helpers';

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
