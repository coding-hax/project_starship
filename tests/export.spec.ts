import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

const EXPORT_BUTTON = 'Alles exportieren';

async function seedTask(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    (p) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: p }),
    payload,
  );
}

/** Assumes the caller already navigated to /einstellungen — offline tests need to get
 * there before dropping the connection, since navigation itself needs the network. */
async function triggerExport(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: EXPORT_BUTTON }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('export: download produced no file');
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(path, 'utf-8');
  return { download, payload: JSON.parse(raw) as Record<string, unknown> };
}

test.beforeEach(async () => {
  await resetAppData();
});

test('Alles exportieren lädt alle lokalen Datensätze als JSON, inklusive Tombstones', async ({
  page,
}) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');

  await seedTask(page, { title: 'Bleibt' });
  const deletedId = await seedTask(page, { title: 'Wird gelöscht' });
  await page.evaluate(
    (rowId) => window.__starship.mutate({ table: 'tasks', op: 'delete', rowId }),
    deletedId,
  );

  await page.goto('/einstellungen');
  const { download, payload } = await triggerExport(page);

  expect(download.suggestedFilename()).toMatch(/^starship-export-\d{4}-\d{2}-\d{2}\.json$/);

  const records = payload.records as Array<{
    table: string;
    id: string;
    deletedAt: string | null;
    data: Record<string, unknown>;
  }>;

  const visible = records.find((r) => r.table === 'tasks' && r.data.title === 'Bleibt');
  expect(visible?.deletedAt).toBeNull();

  const tombstone = records.find((r) => r.table === 'tasks' && r.id === deletedId);
  expect(tombstone).toBeTruthy();
  expect(tombstone?.deletedAt).not.toBeNull();
});

test('der Export enthält Schema-Version und Zeitstempel', async ({ page }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Beliebige Aufgabe' });

  await page.goto('/einstellungen');
  const { payload } = await triggerExport(page);

  expect(typeof payload.schemaVersion).toBe('number');
  expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('der Export funktioniert offline, weil er aus IndexedDB liest', async ({ page, context }) => {
  await registerPasskey(page);
  await page.goto('/aufgaben');
  await seedTask(page, { title: 'Offline-Export-Aufgabe' });

  await page.goto('/einstellungen');
  await context.setOffline(true);

  const { payload } = await triggerExport(page);
  const records = payload.records as Array<{ table: string; data: Record<string, unknown> }>;
  expect(records.some((r) => r.table === 'tasks' && r.data.title === 'Offline-Export-Aufgabe')).toBe(
    true,
  );

  await context.setOffline(false);
});
