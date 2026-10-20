import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { deleteAccount } from '@/features/admin/account-actions';
import {
  createOtherAccount,
  createThrowawayCredential,
  createThrowawaySession,
  currentAccountId,
  freshAdminDevice,
  performStepUp,
  registerPasskey,
  resetAppData,
  setAccountBlocked,
  withDb,
} from './helpers';

/**
 * S5 of #1199 (#1204) — Admin-Aktionen + Audit-Log. E2E nur für K1-K5
 * (ADR-0032); Button-/Dialog-Optik, Dark Mode und reduced-motion sind D1/D7,
 * prüft der Mensch am Gerät.
 */

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page, null);
});

async function auditCount(action: string): Promise<number> {
  const result = await withDb((client) =>
    client.query('SELECT count(*)::int AS n FROM admin_audit WHERE action = $1', [action]),
  );
  return result.rows[0].n as number;
}

async function tableCount(table: string, userId: string): Promise<number> {
  const result = await withDb((client) =>
    client.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]),
  );
  return result.rows[0].n as number;
}

test('AK1/AK8: Sperren über die UI setzt blocked_at, beendet alle Sitzungen, lässt Daten liegen, genau ein Audit-Eintrag', async ({
  page,
}) => {
  const other = await createOtherAccount('Sperrkonto');
  const credentialId = await createThrowawayCredential({ userId: other.userId });
  await createThrowawaySession(credentialId, undefined, other.userId);
  const before = await auditCount('block');

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Sperrkonto' });
  await card.getByRole('button', { name: 'Sperren' }).click();
  await expect(card.getByRole('button', { name: 'Entsperren' })).toBeVisible();

  const row = await withDb((client) =>
    client.query('SELECT blocked_at FROM users WHERE id = $1', [other.userId]),
  );
  expect(row.rows[0].blocked_at).not.toBeNull();
  expect(await tableCount('sessions', other.userId)).toBe(0);
  expect(await tableCount('tasks', other.userId)).toBe(1);
  expect(await auditCount('block')).toBe(before + 1);
});

test('AK2: Entsperren räumt blocked_at, lässt Daten unverändert', async ({ page }) => {
  const other = await createOtherAccount('Entsperrkonto');
  await setAccountBlocked(other.userId, true);
  const before = await auditCount('unblock');

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Entsperrkonto' });
  await card.getByRole('button', { name: 'Entsperren' }).click();
  await expect(card.getByRole('button', { name: 'Sperren' })).toBeVisible();

  const row = await withDb((client) =>
    client.query('SELECT blocked_at FROM users WHERE id = $1', [other.userId]),
  );
  expect(row.rows[0].blocked_at).toBeNull();
  expect(await tableCount('tasks', other.userId)).toBe(1);
  expect(await auditCount('unblock')).toBe(before + 1);
});

test('AK3/AK8/AK10: Zugang neu ausstellen verlangt Step-up, widerruft Geräte und Sitzungen, erzeugt genau einen frischen, gebundenen Link, der nach Neuladen verschwindet', async ({
  browser,
}) => {
  // Step-up (#1224 AK10) needs a real WebAuthn ceremony against the admin's own
  // passkey — the shared AUTH_STATE session's passkey lives on the `setup`
  // project's own page, whose CDP virtual authenticator this page cannot reach.
  const { context, page } = await freshAdminDevice(browser);
  const other = await createOtherAccount('Reissuekonto');
  const credentialId = await createThrowawayCredential({ userId: other.userId });
  await createThrowawaySession(credentialId, undefined, other.userId);
  const before = await auditCount('reissue');

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Reissuekonto' });
  await card.getByRole('button', { name: 'Neu ausstellen' }).click();
  await expect(card.getByText(/\/einladung\//)).toBeVisible();

  expect(await tableCount('credentials', other.userId)).toBe(0);
  expect(await tableCount('sessions', other.userId)).toBe(0);
  expect(await tableCount('tasks', other.userId)).toBe(1);

  const invite = await withDb((client) =>
    client.query(
      "SELECT count(*)::int AS n FROM invites WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()",
      [other.userId],
    ),
  );
  expect(invite.rows[0].n).toBe(1);
  expect(await auditCount('reissue')).toBe(before + 1);

  await page.reload();
  const cardAfterReload = page.locator('li.admin-overview__account', { hasText: 'Reissuekonto' });
  await expect(cardAfterReload.getByText(/\/einladung\//)).toHaveCount(0);
  await expect(cardAfterReload.getByRole('button', { name: 'Neu ausstellen' })).toBeVisible();

  await context.close();
});

test('AK10: Zugang neu ausstellen ohne Step-up scheitert mit 403, ändert nichts', async ({ page, baseURL }) => {
  const other = await createOtherAccount('Reissueverweigert');

  const response = await page.request.post(`/api/admin/accounts/${other.userId}/reissue`, {
    headers: { origin: baseURL! },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error).toBe('step-up-required');

  const invite = await withDb((client) =>
    client.query(
      "SELECT count(*)::int AS n FROM invites WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()",
      [other.userId],
    ),
  );
  expect(invite.rows[0].n).toBe(0);
});

test('AK4/AK10: Journal löschen braucht die doppelte Bestätigung + Step-up und löscht journal_entries/journal_keys hart, andere Daten bleiben', async ({
  browser,
}) => {
  const { context, page } = await freshAdminDevice(browser);
  const other = await createOtherAccount('Journalkonto');
  const before = await auditCount('delete-journal');
  expect(await tableCount('journal_entries', other.userId)).toBe(1);
  expect(await tableCount('journal_keys', other.userId)).toBe(1);

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Journalkonto' });
  const journalRow = card.locator('.row', { hasText: 'Journal löschen' });
  await journalRow.getByRole('button', { name: 'Löschen' }).click();
  await card.getByRole('button', { name: 'Ja, weiter' }).click();

  await expect(card.getByText(/nicht zurückgesetzt werden/)).toBeVisible();
  // `cancel()` revertiert die Bestätigungs-UI synchron, unabhängig vom
  // DELETE-Fetch — die UI alleine ist hier kein verlässlicher Wartepunkt
  // (Memory "diff-scope-decides-if-e2e-red-is-yours" lässt grüßen: ohne das
  // Warten auf die echte Antwort liest die DB-Prüfung vor der Löschung).
  const [deleteResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/admin/accounts/${other.userId}/journal`) &&
        response.request().method() === 'DELETE',
    ),
    card.getByRole('button', { name: 'Journal endgültig löschen' }).click(),
  ]);
  expect(deleteResponse.ok()).toBe(true);

  await expect(card.locator('.row', { hasText: 'Journal löschen' })).toBeVisible();
  expect(await tableCount('journal_entries', other.userId)).toBe(0);
  expect(await tableCount('journal_keys', other.userId)).toBe(0);
  expect(await tableCount('tasks', other.userId)).toBe(1);
  expect(await auditCount('delete-journal')).toBe(before + 1);

  await context.close();
});

test('AK10: Journal löschen ohne Step-up scheitert mit 403, ändert nichts', async ({ page, baseURL }) => {
  const other = await createOtherAccount('Journalverweigert');

  const response = await page.request.delete(`/api/admin/accounts/${other.userId}/journal`, {
    headers: { origin: baseURL! },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error).toBe('step-up-required');
  expect(await tableCount('journal_entries', other.userId)).toBe(1);
});

test('AK4: Abbrechen löscht nichts', async ({ page }) => {
  const other = await createOtherAccount('Journalabbruchkonto');

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Journalabbruchkonto' });
  const journalRow = card.locator('.row', { hasText: 'Journal löschen' });
  await journalRow.getByRole('button', { name: 'Löschen' }).click();
  await card.getByRole('button', { name: 'Abbrechen' }).click();

  await expect(card.locator('.row', { hasText: 'Journal löschen' }).getByRole('button', { name: 'Löschen' })).toBeVisible();
  expect(await tableCount('journal_entries', other.userId)).toBe(1);
});

test('AK5/AK8/AK10: Konto löschen verlangt das Eintippen des Etiketts + Step-up, räumt jede user_id-Tabelle leer', async ({
  browser,
}) => {
  const { context, page } = await freshAdminDevice(browser);
  const other = await createOtherAccount('Löschkonto');
  const before = await auditCount('delete-account');

  await page.goto('/admin');
  const card = page.locator('li.admin-overview__account', { hasText: 'Löschkonto' });
  const deleteRow = card.locator('.row', { hasText: 'Konto löschen' });
  await deleteRow.getByRole('button', { name: 'Löschen' }).click();

  const confirmButton = card.getByRole('button', { name: 'Konto endgültig löschen' });
  await expect(confirmButton).toBeDisabled();
  await card.getByRole('textbox').fill('Löschkonto');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.locator('li.admin-overview__account', { hasText: 'Löschkonto' })).toHaveCount(0);

  for (const table of [
    'users',
    'tasks',
    'habits',
    'events',
    'journal_entries',
    'journal_keys',
    'credentials',
    'sessions',
  ]) {
    const result = await withDb((client) =>
      client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1`, [
        other.userId,
      ]),
    );
    expect(result.rows[0].n, `${table} sollte leer sein`).toBe(0);
  }

  // AK8: das Audit-Log überlebt die Löschung des referenzierten Kontos.
  const audit = await withDb((client) =>
    client.query("SELECT target_user_id, target_label FROM admin_audit WHERE action = 'delete-account' ORDER BY created_at DESC LIMIT 1"),
  );
  expect(audit.rows[0].target_user_id).toBeNull();
  expect(audit.rows[0].target_label).toBe('Löschkonto');
  expect(await auditCount('delete-account')).toBe(before + 1);

  await context.close();
});

test('AK10: Konto löschen ohne Step-up scheitert mit 403, Konto bleibt', async ({ page, baseURL }) => {
  const other = await createOtherAccount('Löschverweigert');

  const response = await page.request.delete(`/api/admin/accounts/${other.userId}`, {
    headers: { origin: baseURL! },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error).toBe('step-up-required');

  const stillThere = await withDb((client) => client.query('SELECT 1 FROM users WHERE id = $1', [other.userId]));
  expect(stillThere.rows.length).toBe(1);
});

test('AK6: die eigene Zeile zeigt keine Aktionsknöpfe, und die API weist einen direkten Zugriff auf die eigene id ab', async ({
  page,
  baseURL,
}) => {
  const adminId = await currentAccountId();
  await createOtherAccount('Nebenkonto');

  await page.goto('/admin');
  // Zwei Konten insgesamt (Admin + Nebenkonto), aber nur eines bekommt einen
  // Aktionsblock — die eigene Zeile bleibt ohne Knöpfe (AK6, UI-Seite).
  await expect(page.locator('li.admin-overview__account')).toHaveCount(2);
  await expect(page.locator('.admin-overview__actions')).toHaveCount(1);

  // `page.request` is Playwright's Node-side HTTP client, not a browser fetch —
  // it never sends an `Origin` header on its own (#1224 AK6), so every direct
  // call here sets one by hand to reach the self/last-admin business logic
  // instead of the CSRF guard; `admin-sicherheit.spec.ts` covers the guard itself.
  const blockResponse = await page.request.patch(`/api/admin/accounts/${adminId}`, {
    headers: { origin: baseURL! },
    data: { action: 'block' },
  });
  expect(blockResponse.status()).toBe(403);
  expect((await blockResponse.json()).error).toBe('self');

  // DELETE now sits behind Step-up (#1224 AK10) first — without one it never
  // reaches the self-check below.
  const deleteWithoutStepUp = await page.request.delete(`/api/admin/accounts/${adminId}`, {
    headers: { origin: baseURL! },
  });
  expect(deleteWithoutStepUp.status()).toBe(403);
  expect((await deleteWithoutStepUp.json()).error).toBe('step-up-required');
});

test('AK6/AK10: ein Löschversuch auf die eigene id scheitert an "self", selbst mit gültigem Step-up', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshAdminDevice(browser);
  const adminId = await currentAccountId();

  const { challenge, assertion } = await performStepUp(page);
  const deleteResponse = await page.request.delete(`/api/admin/accounts/${adminId}`, {
    headers: { origin: baseURL! },
    data: { challenge, assertion },
  });
  expect(deleteResponse.status()).toBe(403);
  expect((await deleteResponse.json()).error).toBe('self');

  await context.close();
});

test('AK7: ein zweites Admin-Konto lässt sich löschen, aber das letzte Admin-Konto ist serverseitig geschützt', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshAdminDevice(browser);
  const secondAdminId = randomUUID();
  await withDb((client) =>
    client.query("INSERT INTO users (id, role, display_name) VALUES ($1, 'admin', 'Zweiter Admin')", [
      secondAdminId,
    ]),
  );

  const { challenge, assertion } = await performStepUp(page);
  const deleteSecond = await page.request.delete(`/api/admin/accounts/${secondAdminId}`, {
    headers: { origin: baseURL! },
    data: { challenge, assertion },
  });
  expect(deleteSecond.status()).toBe(200);
  const remaining = await withDb((client) => client.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin'"));
  expect(remaining.rows[0].n).toBe(1);

  // Das letzte Admin-Konto ist nur über eine Race-Lücke erreichbar (zwei
  // gleichzeitige Löschungen, serialisiert per FOR UPDATE) — die wird laut Plan
  // nicht eigens erzwungen. Stattdessen die Schutzklausel selbst direkt prüfen,
  // mit einem Akteur, der nicht der letzte Admin selbst ist (sonst griffe der
  // Selbst-Schutz zuerst, AK6).
  const onlyAdminId = await currentAccountId();
  const result = await deleteAccount(randomUUID(), onlyAdminId);
  expect(result).toBe('last-admin');
  const stillThere = await withDb((client) => client.query('SELECT 1 FROM users WHERE id = $1', [onlyAdminId]));
  expect(stillThere.rows.length).toBe(1);

  await context.close();
});

test('AK9: keine Antwort einer Aktions-Route enthält Nutzerinhalt', async ({ page, baseURL }) => {
  const other = await createOtherAccount('Inhaltskonto');
  const origin = { origin: baseURL! };

  const blockResponse = await page.request.patch(`/api/admin/accounts/${other.userId}`, {
    headers: origin,
    data: { action: 'block' },
  });
  const unblockResponse = await page.request.patch(`/api/admin/accounts/${other.userId}`, {
    headers: origin,
    data: { action: 'unblock' },
  });
  const reissueResponse = await page.request.post(`/api/admin/accounts/${other.userId}/reissue`, {
    headers: origin,
  });
  const journalResponse = await page.request.delete(`/api/admin/accounts/${other.userId}/journal`, {
    headers: origin,
  });
  const deleteResponse = await page.request.delete(`/api/admin/accounts/${other.userId}`, {
    headers: origin,
  });

  const bodies = await Promise.all(
    [blockResponse, unblockResponse, reissueResponse, journalResponse, deleteResponse].map((response) =>
      response.text(),
    ),
  );

  for (const value of Object.values(other.titles)) {
    for (const body of bodies) {
      expect(body).not.toContain(value);
    }
  }
});
