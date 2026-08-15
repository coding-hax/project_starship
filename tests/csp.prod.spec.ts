import { expect, test, type Page } from '@playwright/test';
import { registerPasskey, resetAppData } from './helpers';

/**
 * Issue #753: the CSP is production-only (middleware.ts — dev needs 'unsafe-eval'
 * for HMR, and every `mobile`-project spec expects a CSP-free console), so this
 * spec runs against the prod-build projects (offline-mobile/offline-desktop),
 * same as navigation.prod.spec.ts.
 */

declare global {
  interface Window {
    __violations: string[];
    __pwned?: boolean;
  }
}

const OPEN_METEO_PATTERN = 'https://api.open-meteo.com/**';
const GARMIN_SYNC_PATTERN = '**/api/garmin-sync';

// Registered via addInitScript (not appendChild-ed DOM state, so the "document.head
// doesn't exist yet" trap doesn't apply) — fires again on every navigation within
// this page, so window.__violations starts fresh each time a test calls page.goto.
async function collectViolations(page: Page) {
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__violations.push(event.violatedDirective);
    });
  });
}

test.describe('angemeldet', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppData();
    // Same leak as navigation.prod.spec.ts: /uebersicht fires a real open-meteo
    // fetch, and /aktivitaeten a real garmin-sync one — both must be mocked or
    // they hang/pollute this spec, which has nothing to do with either.
    await page.route(OPEN_METEO_PATTERN, (route) => route.abort('failed'));
    await page.route(GARMIN_SYNC_PATTERN, (route) =>
      route.fulfill({
        json: { scanned: 0, created: 0, updated: 0, detailsFilled: 0, mapsFilled: 0 },
      }),
    );
    await collectViolations(page);
    await registerPasskey(page);
  });

  test('jede HTML-Antwort trägt eine Content-Security-Policy mit den Mindest-Direktiven (AK1)', async ({
    page,
  }) => {
    const response = await page.goto('/uebersicht');
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("script-src verzichtet in der Produktions-Antwort auf 'unsafe-inline' und 'unsafe-eval' (AK2)", async ({
    page,
  }) => {
    const response = await page.goto('/uebersicht');
    const csp = response?.headers()['content-security-policy'] ?? '';
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'nonce-");
  });

  test('die Nonce ist je Antwort neu — zwei Aufrufe derselben Route liefern zwei verschiedene Werte (AK3)', async ({
    page,
  }) => {
    const first = await page.request.get('/uebersicht');
    const second = await page.request.get('/uebersicht');

    const nonceOf = (csp: string | undefined) => csp?.match(/nonce-([^']+)/)?.[1];
    const n1 = nonceOf(first.headers()['content-security-policy']);
    const n2 = nonceOf(second.headers()['content-security-policy']);

    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  test('der Theme-Bootstrap läuft weiter: gesetztes Theme greift, ohne Verstoß (AK4)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('starship:theme', 'dunkel'));

    await page.goto('/uebersicht');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dunkel');
    expect(await page.evaluate(() => window.__violations)).toEqual([]);
  });

  test('ein zur Laufzeit per DOM eingefügtes Inline-Skript ohne Nonce wird geblockt (AK5)', async ({ page }) => {
    await page.goto('/uebersicht');

    const pwned = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__pwned = true;';
      document.body.appendChild(script);
      return window.__pwned === true;
    });

    expect(pwned).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.__violations))
      .toEqual(expect.arrayContaining([expect.stringContaining('script-src')]));
  });

  test('auf den Hauptrouten tritt kein securitypolicyviolation auf — Service Worker und Wetter-Fetch eingeschlossen (AK6)', async ({
    page,
  }) => {
    await page.goto('/uebersicht');
    // A worker that has claimed this client — its precache fetches run under the
    // same CSP (connect-src), so this is what actually exercises the SW path.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 10_000 })
      .toBe(true);
    expect(await page.evaluate(() => window.__violations)).toEqual([]);

    for (const path of ['/aufgaben', '/kalender', '/routinen', '/journal', '/aktivitaeten', '/einstellungen']) {
      await page.goto(path);
      expect(await page.evaluate(() => window.__violations)).toEqual([]);
    }
  });
});

test.describe('ohne Session-Cookie', () => {
  // Opts out of the shared owner session (#115) — an authenticated visit to
  // /anmelden just redirects to /uebersicht, which this test isn't about.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('auf /anmelden tritt kein securitypolicyviolation auf (AK6)', async ({ page }) => {
    await collectViolations(page);

    await page.goto('/anmelden');
    await expect(page.getByRole('button', { name: 'Passkey einrichten' })).toBeVisible();

    expect(await page.evaluate(() => window.__violations)).toEqual([]);
  });
});
