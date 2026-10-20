import { expect, test } from '@playwright/test';
import { ADMIN_NOT_FOUND_PATH } from '@/auth/admin-route';
import {
  createOtherAccount,
  currentAccountId,
  nonAdminContext,
  registerPasskey,
  resetAppData,
  seedInvite,
  setAccountBlocked,
  withDb,
} from './helpers';

/**
 * S7 of #1199 (#1224) — Sicherheits-Härtung des Admin-Bereichs. E2E nur für
 * K1-K5 (ADR-0032); AK1 (Bedrohungsmodell) ist Doku, kein e2e.
 */

test.beforeEach(async ({ page }) => {
  await resetAppData();
  await registerPasskey(page, null);
});

/**
 * Both AK5 bodies are the same generic 404 page rendered twice, each from its
 * own request — two dev-only, per-render artifacts never match byte-for-byte
 * on their own even when the page is otherwise identical:
 *
 * 1. `next dev` stamps every asset URL (`?v=<ms-timestamp>`) with the
 *    live-reload clock at render time (confirmed via CI: a diff of exactly
 *    the `?v=` digits, nothing else). Same dev-only artifact as the `AK8`
 *    comment below, just inside the body instead of a header.
 * 2. Next's RSC bootstrap script carries a fresh `self.__next_r="<id>"` on
 *    every single render, even two requests to the exact same URL back to
 *    back (confirmed locally: identical `?v=`-stripped bodies for one path
 *    requested twice, differing only in this id) — unrelated to routing,
 *    nothing byte-equality here could ever meaningfully check.
 *
 * Neither is content-hashed production assets' problem, so normalize both
 * away rather than move this to a `.prod.spec.ts`.
 */
function stripDevAssetVersion(html: string): string {
  return html.replace(/\?v=\d+/g, '?v=X').replace(/__next_r="[^"]*"/g, '__next_r="X"');
}

test('AK3: ein während der Sitzung herabgestuftes oder gesperrtes Admin-Konto scheitert an seiner nächsten Anfrage, ohne neuen Login', async ({
  page,
}) => {
  const adminId = await currentAccountId();
  try {
    // Downgrade: die nächste Anfrage über dieselbe, nie erneuerte Sitzung muss
    // den Admin-Bereich byte-gleich zu einer nicht existierenden Route sehen
    // (AK5), nicht nur irgendeinen Fehler.
    await withDb((client) => client.query("UPDATE users SET role = 'user' WHERE id = $1", [adminId]));
    const downgraded = await page.request.get('/api/admin/accounts');
    const unknown = await page.request.get(ADMIN_NOT_FOUND_PATH);
    expect(downgraded.status()).toBe(unknown.status());
    expect(await downgraded.text()).toBe(await unknown.text());

    // Sperren statt herabstufen: `requireUser()` wirft `AccountBlockedError`
    // (403) noch vor der Rollenprüfung — die Rolle bleibt hier absichtlich
    // 'admin', damit der Test wirklich die Sperre prüft, nicht erneut AK5.
    await withDb((client) => client.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]));
    await setAccountBlocked(adminId, true);
    const blocked = await page.request.get('/api/admin/accounts');
    expect(blocked.status()).toBe(403);
  } finally {
    // Der geteilte AUTH_STATE-Cookie gehört exakt diesem Konto — ohne
    // Wiederherstellung bliebe jeder spätere Test in dieser Datei (und jeder
    // Folge-Worker, der dieselbe Sitzung erbt) ohne gültigen Admin zurück.
    await withDb((client) => client.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]));
    await setAccountBlocked(adminId, false);
  }
});

test('AK7: ein Anzeigename mit eingebettetem Skript erscheint in /admin nur als Text, löst nichts aus', async ({
  page,
}) => {
  const xssLabel = '<img src=x onerror="window.__xss=1">';
  await createOtherAccount(xssLabel);

  await page.goto('/admin');
  await expect(page.getByText(xssLabel, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('AK5 (API): /api/admin/accounts antwortet einem Nutzer-Konto byte-gleich zu einer nicht existierenden API-Route', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await nonAdminContext(browser, baseURL);

  // `guardAdmin()` answers a non-admin with a redirect to `ADMIN_NOT_FOUND_PATH`
  // (AK5) and `page.request.get` follows it, so `adminApi` actually renders AT
  // that path — comparing against anything else would fail on Next's RSC
  // bootstrap script, which embeds the response's own URL (the router state a
  // genuinely unmatched route needs for client-side hydration) and therefore
  // differs between any two distinct paths regardless of admin-gating.
  const adminApi = await page.request.get('/api/admin/accounts');
  const unknownApi = await page.request.get(ADMIN_NOT_FOUND_PATH);
  expect(adminApi.status()).toBe(unknownApi.status());
  expect(stripDevAssetVersion(await adminApi.text())).toBe(stripDevAssetVersion(await unknownApi.text()));

  await close();
});

test('AK5 (Seite): /admin antwortet einem Nutzer-Konto byte-gleich zu einer nicht existierenden Seite', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await nonAdminContext(browser, baseURL);

  // Read each navigation's body before the next `goto` replaces the frame —
  // Playwright's `Response.text()` throws once the frame has moved on. Compare
  // against `ADMIN_NOT_FOUND_PATH` itself, not an unrelated made-up path — see
  // the comment on the API test above for why any other target never matches.
  const adminResponse = await page.goto('/admin');
  const adminStatus = adminResponse?.status();
  const adminBody = await adminResponse?.text();

  const unknownResponse = await page.goto(ADMIN_NOT_FOUND_PATH);
  const unknownStatus = unknownResponse?.status();
  const unknownBody = await unknownResponse?.text();

  expect(adminStatus).toBe(unknownStatus);
  expect(stripDevAssetVersion(adminBody ?? '')).toBe(stripDevAssetVersion(unknownBody ?? ''));

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

// AK8's page-level Cache-Control assertion lives in admin-cache.prod.spec.ts —
// Next's dev server unconditionally overwrites a page's Cache-Control with
// `no-cache, must-revalidate`, so middleware.ts's own `no-store` only ever
// survives in a production build. The API route isn't subject to that dev-only
// override, so it stays here.
test('AK8: /api/admin/accounts trägt Cache-Control: no-store', async ({ page }) => {
  const apiResponse = await page.request.get('/api/admin/accounts');
  expect(apiResponse.headers()['cache-control']).toBe('no-store');
});

test('AK9: /einladung/<token> trägt Referrer-Policy: no-referrer', async ({ page }) => {
  const adminId = await currentAccountId();
  const token = await seedInvite({ createdBy: adminId, label: 'Referrer-Test' });

  const response = await page.request.get(`/einladung/${token}`);
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});
