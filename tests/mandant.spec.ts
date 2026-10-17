import { expect, test } from '@playwright/test';
import { JOURNAL_HABIT_ID } from '@/features/journal/journal-habit';
import { JOURNAL_KEYS_ROW_ID } from '@/features/journal/journal-keys';
import { SYNC_TABLES } from '@/local/types';
import {
  createOtherAccount,
  currentAccountId,
  deleteAccount,
  registerPasskey,
  resetAppData,
  setAccountBlocked,
  withDb,
} from './helpers';

/**
 * Mandantentrennung (#1200, ADR-0031) — ein Test je Akzeptanzkriterium.
 *
 * Die Prüfungen gehen bewusst an der UI vorbei: sie halten die Antwort von
 * `/api/sync/*` und den Inhalt der Datenbank gegen ein **zweites Konto**, das
 * direkt per SQL eingesetzt wird. Über die Oberfläche gäbe es gar keinen Weg,
 * fremde Daten anzufordern — genau deshalb beweist die Oberfläche hier nichts.
 */

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page);
});

async function pullAll(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/sync/pull?since=0');
  expect(response.status(), 'Pull muss für das eigene Konto 200 liefern').toBe(200);
  return (await response.json()) as {
    changes: Array<{ table: string; id: string; data: Record<string, unknown> }>;
  };
}

test('AK5: beide Konten halten dieselbe feste JOURNAL_HABIT_ID, ohne einander zu überschreiben', async ({
  page,
}) => {
  const other = await createOtherAccount('AK5');

  // Das eigene Konto legt die Journal-Routine unter derselben eincodierten id an.
  await page.evaluate(() => window.__starship.ensureJournalHabit());
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT user_id, name FROM habits WHERE id = $1 ORDER BY name', [
      JOURNAL_HABIT_ID,
    ]),
  );

  expect(rows.rows, 'die feste id existiert genau einmal je Konto').toHaveLength(2);
  const owners = rows.rows.map((row) => row.user_id as string);
  expect(new Set(owners).size, 'zwei verschiedene Eigentümer').toBe(2);
  expect(owners).toContain(other.userId);
  // Die fremde Zeile trägt weiterhin ihren eigenen Namen, nicht den unseren.
  const foreign = rows.rows.find((row) => row.user_id === other.userId);
  expect(foreign?.name).toBe(other.titles.habit);
});

test('AK5: dasselbe gilt für die feste JOURNAL_KEYS_ROW_ID — zwei Hüllen, keine überschrieben', async ({
  page,
}) => {
  const other = await createOtherAccount('AK5-Keys');
  const mine = await currentAccountId();

  await page.evaluate(
    ([rowId]) =>
      window.__starship.mutate({
        table: 'journal_keys',
        rowId,
        op: 'upsert',
        payload: { envelope: { marker: 'eigene' } },
      }),
    [JOURNAL_KEYS_ROW_ID],
  );
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const rows = await withDb((client) =>
    client.query('SELECT user_id, envelope FROM journal_keys WHERE id = $1', [
      JOURNAL_KEYS_ROW_ID,
    ]),
  );

  expect(rows.rows).toHaveLength(2);
  const foreign = rows.rows.find((row) => row.user_id === other.userId);
  const own = rows.rows.find((row) => row.user_id === mine);
  expect(foreign?.envelope, 'fremde Hülle unberührt').toEqual({});
  expect(own?.envelope).toEqual({ marker: 'eigene' });
});

test('AK6: beide Konten dürfen denselben sync_state.key, kind und category tragen', async ({
  page,
}) => {
  const other = await createOtherAccount('AK6');

  // `createOtherAccount` hat bereits cursor/tasks-due/arbeit belegt — das eigene
  // Konto belegt dieselben Schlüssel noch einmal.
  await page.evaluate(() =>
    window.__starship.mutate({
      table: 'reminder_prefs',
      op: 'upsert',
      payload: { kind: 'tasks-due', enabled: true, times: ['07:00'] },
    }),
  );
  await page.evaluate(() =>
    window.__starship.mutate({
      table: 'category_colors',
      op: 'upsert',
      payload: { category: 'arbeit', color: '--swatch-sky' },
    }),
  );
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const prefs = await withDb((client) =>
    client.query("SELECT user_id FROM reminder_prefs WHERE kind = 'tasks-due'"),
  );
  const colors = await withDb((client) =>
    client.query("SELECT user_id FROM category_colors WHERE category = 'arbeit'"),
  );

  expect(prefs.rows, 'ein tasks-due je Konto').toHaveLength(2);
  expect(colors.rows, 'ein arbeit je Konto').toHaveLength(2);
  expect(prefs.rows.map((r) => r.user_id)).toContain(other.userId);
});

test('AK7: ein Log auf die Routine eines fremden Kontos scheitert an der Datenbank', async () => {
  const other = await createOtherAccount('AK7');
  const mine = await currentAccountId();

  // Eine Routine, die es nur beim fremden Konto gibt — nicht die feste id, die
  // beide Konten legitim besitzen.
  const foreignHabit = await withDb((client) =>
    client.query(
      `INSERT INTO habits (user_id, id, updated_at, synced_at, sync_seq, name, schedule)
       VALUES ($1, gen_random_uuid(), now(), now(), nextval('sync_seq'), 'Nur dort', 'daily')
       RETURNING id`,
      [other.userId],
    ),
  );
  const habitId = foreignHabit.rows[0].id as string;

  const attempt = withDb((client) =>
    client.query(
      `INSERT INTO habit_logs (user_id, id, updated_at, synced_at, sync_seq, habit_id, log_date)
       VALUES ($1, gen_random_uuid(), now(), now(), nextval('sync_seq'), $2, '2026-07-19')`,
      [mine, habitId],
    ),
  );

  // 23503 = foreign_key_violation. Die Trennung hält an der Datenbank, nicht an
  // einer Prüfung im Code (ADR-0031).
  await expect(attempt).rejects.toThrow(/violates foreign key constraint/);
});

test('AK8: ein gesperrtes Konto bekommt 403 blocked, ein unangemeldetes 401', async ({
  page,
  browser,
}) => {
  const mine = await currentAccountId();

  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const unauthorized = await anonymous.request.get('/api/sync/pull?since=0');
    expect(unauthorized.status(), 'ohne Sitzung: 401').toBe(401);
    expect((await unauthorized.json()).error).toBe('Unauthorized');
  } finally {
    await anonymous.close();
  }

  await setAccountBlocked(mine, true);
  try {
    const blocked = await page.request.get('/api/sync/pull?since=0');
    expect(blocked.status(), 'gesperrt: 403, nicht 401').toBe(403);
    expect(
      (await blocked.json()).error,
      'eigener Fehlercode, damit der Client Sperre von Abmeldung unterscheiden kann',
    ).toBe('blocked');

    const push = await page.request.post('/api/sync/push', { data: { mutations: [] } });
    expect(push.status(), 'auch der Schreibweg ist zu').toBe(403);
  } finally {
    await setAccountBlocked(mine, false);
  }
});

test('AK9: der Pull liefert keine einzige Zeile des fremden Kontos — über alle Tabellen', async ({
  page,
}) => {
  const other = await createOtherAccount('AK9');
  const mine = await currentAccountId();

  const { changes } = await pullAll(page);

  // Jede gelieferte Zeile muss dem eigenen Konto gehören. Geprüft wird gegen die
  // Datenbank, nicht gegen die Antwort: `user_id` steht bewusst in keiner
  // Pull-Projektion, der Client braucht es nicht.
  for (const table of SYNC_TABLES) {
    const ids = changes.filter((c) => c.table === table).map((c) => c.id);
    if (ids.length === 0) continue;
    const owners = await withDb((client) =>
      client.query(`SELECT DISTINCT user_id FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]),
    );
    const foreign = owners.rows.filter((row) => row.user_id !== mine);
    expect(foreign, `Tabelle ${table} liefert nur eigene Zeilen`).toEqual([]);
  }

  // Und die Gegenprobe, damit der Test nicht nur deshalb grün ist, weil nichts
  // geliefert wurde: die bekannten Inhalte des fremden Kontos tauchen nirgends auf.
  const body = JSON.stringify(changes);
  for (const value of Object.values(other.titles)) {
    expect(body, `"${value}" darf nicht im Pull stehen`).not.toContain(value);
  }
});

test('AK10: ein Push auf die rowId eines fremden Kontos legt eine eigene Zeile an, überschreibt nichts', async ({
  page,
}) => {
  const other = await createOtherAccount('AK10');
  const mine = await currentAccountId();

  const before = await withDb((client) =>
    client.query('SELECT id, title, sync_seq FROM tasks WHERE user_id = $1', [other.userId]),
  );
  const foreignTask = before.rows[0];

  await page.evaluate(
    ([rowId]) =>
      window.__starship.mutate({
        table: 'tasks',
        rowId,
        op: 'upsert',
        payload: { title: 'Übernahmeversuch' },
      }),
    [foreignTask.id as string],
  );
  await page.evaluate(() => window.__starship.sync());
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  const after = await withDb((client) =>
    client.query('SELECT user_id, title, sync_seq FROM tasks WHERE id = $1 ORDER BY user_id', [
      foreignTask.id,
    ]),
  );

  expect(after.rows, 'dieselbe id, zwei Zeilen — eine je Konto').toHaveLength(2);
  const foreign = after.rows.find((row) => row.user_id === other.userId);
  const own = after.rows.find((row) => row.user_id === mine);
  expect(foreign?.title, 'fremde Zeile unverändert').toBe(foreignTask.title);
  expect(Number(foreign?.sync_seq), 'fremde Zeile hat keine neue Sequenz bekommen').toBe(
    Number(foreignTask.sync_seq),
  );
  expect(own?.title).toBe('Übernahmeversuch');
});

test('AK11: Lücken in der sync_seq durch ein fremdes Konto überspringen keine eigene Zeile', async ({
  page,
}) => {
  const other = await createOtherAccount('AK11');

  // Abwechselnd schreiben, damit die Sequenz des eigenen Kontos durchlöchert ist.
  const ownTitles: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const title = `AK11 eigene ${i}`;
    ownTitles.push(title);
    await page.evaluate(
      ([t]) => window.__starship.mutate({ table: 'tasks', op: 'upsert', payload: { title: t } }),
      [title],
    );
    await page.evaluate(() => window.__starship.sync());
    await withDb((client) =>
      client.query(
        `INSERT INTO tasks (user_id, id, updated_at, synced_at, sync_seq, title)
         VALUES ($1, gen_random_uuid(), now(), now(), nextval('sync_seq'), $2)`,
        [other.userId, `AK11 fremde ${i}`],
      ),
    );
  }
  await expect.poll(() => page.evaluate(() => window.__starship.size())).toBe(0);

  // Ein frischer Pull ab 0 muss alle vier eigenen Aufgaben bringen, obwohl
  // zwischen ihren Sequenznummern jeweils eine fremde liegt.
  const { changes } = await pullAll(page);
  const titles = changes
    .filter((c) => c.table === 'tasks')
    .map((c) => c.data.title as string);

  for (const title of ownTitles) {
    expect(titles, `${title} darf nicht übersprungen werden`).toContain(title);
  }
  expect(titles.filter((t) => t.startsWith('AK11 fremde'))).toEqual([]);
});

test('Konto löschen nimmt jede eigene Zeile mit und keine fremde', async () => {
  const other = await createOtherAccount('Kaskade');
  const mine = await currentAccountId();

  const mineBefore = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM tasks WHERE user_id = $1', [mine]),
  );

  await deleteAccount(other.userId);

  for (const table of SYNC_TABLES) {
    const left = await withDb((client) =>
      client.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [other.userId]),
    );
    expect(left.rows[0].n, `${table} hält keine Zeile des gelöschten Kontos mehr`).toBe(0);
  }

  const mineAfter = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM tasks WHERE user_id = $1', [mine]),
  );
  expect(mineAfter.rows[0].n, 'das eigene Konto bleibt unberührt').toBe(mineBefore.rows[0].n);
});
