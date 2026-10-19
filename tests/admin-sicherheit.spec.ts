import { expect, test } from '@playwright/test';
import { createOtherAccount, currentAccountId, nonAdminContext, registerPasskey, resetAppData, seedInvite } from './helpers';

/**
 * S7 of #1199 (#1224) — Sicherheits-Härtung des Admin-Bereichs. E2E nur für
 * K1-K5 (ADR-0032); AK1 (Bedrohungsmodell) ist Doku, kein e2e.
 */

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page, null);
});

test('AK5: /admin und /api/admin/accounts antworten einem Nutzer-Konto byte-gleich zu einer nicht existierenden Route', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await nonAdminContext(browser, baseURL);

  // Read each navigation's body before the next `goto` replaces the frame —
  // Playwright's `Response.text()` throws once the frame has moved on.
  const adminResponse = await page.goto('/admin');
  const adminStatus = adminResponse?.status();
  const adminBody = await adminResponse?.text();

  const unknownResponse = await page.goto('/dieser-pfad-existiert-nicht-1224');
  const unknownStatus = unknownResponse?.status();
  const unknownBody = await unknownResponse?.text();

  expect(adminStatus).toBe(unknownStatus);
  expect(adminBody).toBe(unknownBody);

  const adminApi = await page.request.get('/api/admin/accounts');
  const unknownApi = await page.request.get('/api/dieser-pfad-existiert-nicht-1224');
  expect(adminApi.status()).toBe(unknownApi.status());
  expect(await adminApi.text()).toBe(await unknownApi.text());

  await close();
});

test('AK6: eine ändernde Admin-Aktion mit fremdem oder fehlendem Origin scheitert mit 403, auch mit gültigem Admin-Cookie', async ({
  page,
}) => {
  const other = await createOtherAccount('Origin-Testkonto');

  const noOrigin = await page.request.patch(`/api/admin/accounts/${other.userId}`, {
    data: { action: 'block' },
  });
  expect(noOrigin.status()).toBe(403);
  expect((await noOrigin.json()).error).toBe('forbidden-origin');

  const foreignOrigin = await page.request.patch(`/api/admin/accounts/${other.userId}`, {
    headers: { origin: 'https://evil.example' },
    data: { action: 'block' },
  });
  expect(foreignOrigin.status()).toBe(403);
  expect((await foreignOrigin.json()).error).toBe('forbidden-origin');

  const deleteNoOrigin = await page.request.delete(`/api/admin/accounts/${other.userId}`);
  expect(deleteNoOrigin.status()).toBe(403);

  const reissueNoOrigin = await page.request.post(`/api/admin/accounts/${other.userId}/reissue`);
  expect(reissueNoOrigin.status()).toBe(403);

  const journalNoOrigin = await page.request.delete(`/api/admin/accounts/${other.userId}/journal`);
  expect(journalNoOrigin.status()).toBe(403);

  // Keine der abgelehnten Anfragen hat etwas verändert.
  const blockResponse = await page.request.get('/api/admin/accounts');
  const body = await blockResponse.json();
  const row = body.accounts.find((account: { id: string }) => account.id === other.userId);
  expect(row.status).toBe('eingeladen');
});

test('AK6: GET unter /api/admin/* löst keine Aktion aus (CSRF-sicher ohne Origin-Zwang)', async ({ page }) => {
  await createOtherAccount('Lesekonto');
  const response = await page.request.get('/api/admin/accounts');
  expect(response.ok()).toBe(true);
});

test('AK8: /admin und /api/admin/accounts tragen Cache-Control: no-store', async ({ page }) => {
  const pageResponse = await page.goto('/admin');
  expect(pageResponse?.headers()['cache-control']).toBe('no-store');

  const apiResponse = await page.request.get('/api/admin/accounts');
  expect(apiResponse.headers()['cache-control']).toBe('no-store');
});

test('AK9: /einladung/<token> trägt Referrer-Policy: no-referrer', async ({ page }) => {
  const adminId = await currentAccountId();
  const token = await seedInvite({ createdBy: adminId, label: 'Referrer-Test' });

  const response = await page.request.get(`/einladung/${token}`);
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});
