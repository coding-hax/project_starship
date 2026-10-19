import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { currentAccountId, resetAppData, withDb } from './helpers';

/**
 * #1205 AC6. `storage_limit_bytes` is server-infra (`src/db/schema.ts`), not a
 * synced field — set directly via SQL, the same way other suites reach into
 * infra tables they don't own a mutation path for (e.g. `setAccountBlocked`).
 */
async function setStorageLimit(userId: string, bytes: number | null): Promise<void> {
  await withDb((client) =>
    client.query('UPDATE users SET storage_limit_bytes = $2 WHERE id = $1', [userId, bytes]),
  );
}

async function insertTask(userId: string, title: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO tasks (user_id, id, updated_at, deleted_at, synced_at, sync_seq, title)
       VALUES ($1, $2, now(), NULL, now(), nextval('sync_seq'), $3)`,
      [userId, randomUUID(), title],
    ),
  );
}

function upsertMutation(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    table: 'tasks',
    rowId: randomUUID(),
    op: 'upsert',
    payload: { title: 'Quota-Test' },
    updatedAt: '2026-07-20T12:00:00.000Z',
    baseSeq: null,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetAppData();
});

test('ein Konto über seinem Speicherlimit bekommt 413 mit deutscher Meldung — Lesen bleibt möglich (AC6)', async ({
  request,
}) => {
  const userId = await currentAccountId();
  await insertTask(userId, 'Belegt schon etwas Platz');
  await setStorageLimit(userId, 1); // weit unter dem, was die eine Zeile oben schon belegt

  const push = await request.post('/api/sync/push', { data: { mutations: [upsertMutation()] } });
  expect(push.status()).toBe(413);
  const body = await push.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).toMatch(/Speicher/);

  const pull = await request.get('/api/sync/pull');
  expect(pull.status()).toBe(200);
});

test('eine reine delete-Charge kommt auch über dem Limit durch — ein volles Konto kann sich befreien (AC6)', async ({
  request,
}) => {
  const userId = await currentAccountId();
  await insertTask(userId, 'Belegt schon etwas Platz');
  await setStorageLimit(userId, 1);

  const deleteOnly = upsertMutation({ op: 'delete', payload: {} });
  const response = await request.post('/api/sync/push', { data: { mutations: [deleteOnly] } });

  expect(response.status()).toBe(200);
});

test('ein großzügiges Limit lässt den Push normal durch (AC6)', async ({ request }) => {
  const userId = await currentAccountId();
  await insertTask(userId, 'Belegt schon etwas Platz');
  await setStorageLimit(userId, 100 * 1024 * 1024);

  const response = await request.post('/api/sync/push', { data: { mutations: [upsertMutation()] } });

  expect(response.status()).toBe(200);
});
