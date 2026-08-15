import { expect, test } from '@playwright/test';
import { registerPasskey, resetDatabase, resetRateLimits, withDb } from './helpers';

/**
 * Issue #755. `/api/auth/login/options` and `/api/auth/register/options` are
 * unauthenticated and each write a row to `auth_challenges` — unthrottled, anyone on
 * the network could drive DB write load. Recovery-code attempts had no budget at all.
 *
 * Production windows (5 min for `options`, 60 min for `recovery`,
 * `src/auth/rate-limit.ts`) don't fit an E2E run. AK1/AK3 trip the budget with fast
 * requests that land in the same window regardless. AK2 ages the stored counter rows
 * instead of waiting on the wall clock — injected *state*, not a shortened window or
 * a raised timeout (Regel 5).
 *
 * All requests in this suite share the `unknown` `clientKey` (no proxy in front of
 * the dev server, see `src/auth/rate-limit.ts`) — that's what makes a shared counter
 * observable across `page`/second-context requests here, and why every test resets
 * `auth_rate_limits` first.
 */

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterEach(async () => {
  await resetRateLimits();
});

async function authChallengeCount(): Promise<number> {
  const result = await withDb((client) => client.query('SELECT count(*)::int AS count FROM auth_challenges'));
  return (result.rows[0] as { count: number }).count;
}

async function rateLimitCount(bucket: 'options' | 'recovery'): Promise<number> {
  const result = await withDb((client) =>
    client.query(
      'SELECT count FROM auth_rate_limits WHERE bucket = $1 ORDER BY window_start DESC LIMIT 1',
      [bucket],
    ),
  );
  return (result.rows[0] as { count: number } | undefined)?.count ?? 0;
}

async function ageRateLimitWindows(minutes: number): Promise<void> {
  await withDb((client) =>
    client.query(
      "UPDATE auth_rate_limits SET window_start = window_start - ($1 || ' minutes')::interval",
      [String(minutes)],
    ),
  );
}

test('AK1: der 21. login/options-Aufruf im Fenster liefert 429 mit Retry-After statt eine Challenge zu schreiben', async ({
  page,
}) => {
  for (let i = 0; i < 20; i += 1) {
    const res = await page.request.post('/api/auth/login/options');
    expect(res.status()).toBe(200);
  }

  const before = await authChallengeCount();
  const blocked = await page.request.post('/api/auth/login/options');

  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(0);
  expect(await authChallengeCount()).toBe(before);
});

test('AK2/AK6: nach Ablauf des Fensters ist derselbe Absender wieder erfolgreich — die Sperre ist zeitlich, nicht dauerhaft', async ({
  page,
}) => {
  for (let i = 0; i < 20; i += 1) {
    const res = await page.request.post('/api/auth/login/options');
    expect(res.status()).toBe(200);
  }
  const blocked = await page.request.post('/api/auth/login/options');
  expect(blocked.status()).toBe(429);

  await ageRateLimitWindows(10);

  const afterWindow = await page.request.post('/api/auth/login/options');
  expect(afterWindow.status()).toBe(200);
});

test('AK3: ein Recovery-Fehlversuch zaehlt gegen ein eigenes, strengeres Budget als options', async ({
  page,
  browser,
}) => {
  // firstSetup=false is what makes a wrong recovery code answer 403 rather than
  // silently allowing an unauthenticated first-time registration.
  await registerPasskey(page);

  // A logged-out "device" — recovery is exercised without a session, same
  // reasoning as `openRecoveryDevice` in auth-recovery-register.spec.ts.
  const context = await browser.newContext();
  const loggedOutPage = await context.newPage();

  for (let i = 0; i < 5; i += 1) {
    const res = await loggedOutPage.request.post('/api/auth/register/options', {
      data: { recoveryCode: 'FALSCHER-RECOVERY-CODE' },
    });
    expect(res.status()).toBe(403);
  }

  const sixth = await loggedOutPage.request.post('/api/auth/register/options', {
    data: { recoveryCode: 'FALSCHER-RECOVERY-CODE' },
  });
  expect(sixth.status()).toBe(429);
  expect(Number(sixth.headers()['retry-after'])).toBeGreaterThan(0);

  // The far more generous options budget (20) is untouched by the six recovery
  // attempts — a plain login/options call from the same sender still succeeds.
  const loginRes = await loggedOutPage.request.post('/api/auth/login/options');
  expect(loginRes.status()).toBe(200);

  await context.close();
});

test('AK4: der Zaehler liegt in Postgres, nicht im Prozessspeicher', async ({ page }) => {
  for (let i = 0; i < 3; i += 1) {
    const res = await page.request.post('/api/auth/login/options');
    expect(res.status()).toBe(200);
  }

  expect(await rateLimitCount('options')).toBeGreaterThanOrEqual(3);
});
