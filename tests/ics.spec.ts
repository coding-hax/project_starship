import { expect, test } from '@playwright/test';
import { AUTH_RATE_LIMITS } from '@/auth/rate-limit';
import { createOtherAccount, createThrowawaySession, resetRateLimits } from './helpers';

/**
 * `url=http://x` fails `assertPublicHttpsUrl` (src/app/api/ics/ssrf.ts) before any
 * DNS lookup or fetch — fast and deterministic, and the rate limit is still counted
 * ahead of that check (route.ts), so a budget-exhaustion loop never needs the network
 * at all. Same shape as `auth-rate-limit.spec.ts`'s loop, just against an
 * authenticated, per-account bucket (#1205 AC5) instead of an unauthenticated one.
 */
const NON_HTTPS_URL = '/api/ics?url=http://x';

test.afterEach(async () => {
  await resetRateLimits();
});

test('das 31. /api/ics-Aufruf im Fenster liefert 429, ohne die SSRF-Pruefung zu aendern (AC5)', async ({
  page,
}) => {
  for (let i = 0; i < AUTH_RATE_LIMITS.ics.limit; i += 1) {
    const res = await page.request.get(NON_HTTPS_URL);
    expect(res.status()).toBe(400);
  }

  const blocked = await page.request.get(NON_HTTPS_URL);
  expect(blocked.status()).toBe(429);
  expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(0);
});

test('ein zweites Konto behinter derselben Adresse hat ein eigenes, unberuehrtes Budget (AC5)', async ({
  page,
  browser,
  baseURL,
}) => {
  for (let i = 0; i <= AUTH_RATE_LIMITS.ics.limit; i += 1) {
    await page.request.get(NON_HTTPS_URL);
  }
  const accountABlocked = await page.request.get(NON_HTTPS_URL);
  expect(accountABlocked.status()).toBe(429);

  const other = await createOtherAccount('ICS-B');
  const sessionB = await createThrowawaySession(undefined, undefined, other.userId);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await context.addCookies([{ name: 'starship_session', value: sessionB.token, url: baseURL }]);
  const pageB = await context.newPage();

  const accountBResult = await pageB.request.get(NON_HTTPS_URL);
  expect(accountBResult.status()).toBe(400);

  await context.close();
});
