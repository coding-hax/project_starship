import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

export const DEVICE_COOKIE = 'starship_device';

/**
 * Deliberately longer-lived than the session cookie (365 days,
 * `SESSION_TTL_DAYS`). A device cookie that expired first would turn a living,
 * logged-in device into a brand new one on its next login — and that is exactly
 * the residue this column exists to avoid.
 */
const DEVICE_TTL_DAYS = 5 * 365;

function expiry(): Date {
  return new Date(Date.now() + DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function write(id: string, store: Awaited<ReturnType<typeof cookies>>): void {
  store.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiry(),
  });
}

/**
 * The browser's device id, minted on first sight.
 *
 * This is a *label*, never a key: it says which browser profile a session was
 * opened from, and nothing in the authorisation path ever reads it. Forging it
 * buys an attacker nothing — `requireOwner()` still needs the session token.
 *
 * Route-handler context only (it writes a cookie).
 */
export async function ensureDeviceId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(DEVICE_COOKIE)?.value;
  if (existing) return existing;

  const id = randomUUID();
  write(id, store);
  return id;
}

/**
 * Re-stamps the cookie from the session row whenever the two disagree — the row
 * is the truth, the cookie only its imprint in the browser.
 *
 * Covers both directions of the same failure: a cookie lost while the session
 * lived on (cleared site data, an expiry someone shortened) would otherwise make
 * the next login look like a new device, and a foreign or stale value would
 * mislabel this one. Neither may rewrite `sessions.device_id`.
 *
 * Route-handler context only (it writes a cookie).
 */
export async function healDeviceCookie(deviceId: string | null): Promise<void> {
  if (!deviceId) return;

  const store = await cookies();
  if (store.get(DEVICE_COOKIE)?.value === deviceId) return;

  write(deviceId, store);
}
