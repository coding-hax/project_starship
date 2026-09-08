import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { sessions } from '@/db/schema';
import { ensureDeviceId, healDeviceCookie } from './device-cookie';
import { SESSION_COOKIE } from './session-cookie';

export { SESSION_COOKIE };

/** Long-lived on purpose: the goal is never having to log in again. */
const SESSION_TTL_DAYS = 365;

/** How often `last_seen_at` may advance for one session (issue #1103 AC3). */
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a session and sets the cookie. The raw token is returned to the browser
 * once, inside the cookie; the database only ever sees its hash. `credentialId`
 * binds the session to the passkey that minted it (issue #854) — omitted for the
 * throwaway/legacy paths that have no credential to bind to.
 */
export async function createSession(credentialId: string | null = null): Promise<void> {
  const id = uuidv7();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const deviceId = await ensureDeviceId();

  await db.insert(sessions).values({
    id,
    tokenHash: hashToken(token),
    expiresAt,
    credentialId,
    deviceId,
  });

  if (credentialId) {
    // One live session per device: drop this credential's login residue so the
    // "other sessions" count reflects distinct devices, not stale logins (#857).
    //
    // "Device" is the browser profile, not the passkey (#1102). A passkey synced
    // through a keychain is the same credential on an iPhone and a Mac, so the
    // old credential-wide sweep logged the other one out on every switch. Rows
    // with no device id are pre-#1102 residue and still belong to whoever is
    // logging in — there is no other device they could be attributed to.
    await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.credentialId, credentialId),
          ne(sessions.id, id),
          or(eq(sessions.deviceId, deviceId), isNull(sessions.deviceId)),
        ),
      );
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

/** Returns the owner id when the request carries a live session, otherwise null. */
export async function getSession(): Promise<{
  userId: string;
  sessionId: string;
  credentialId: string | null;
  deviceId: string | null;
  lastSeenAt: Date | null;
} | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  const ownerId = process.env.OWNER_USER_ID;
  if (!ownerId) throw new Error('OWNER_USER_ID is not set.');

  return {
    userId: ownerId,
    sessionId: row.id,
    credentialId: row.credentialId,
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt,
  };
}

/** The credential id of the current session, or null (no session / legacy session). */
export async function currentCredentialId(): Promise<string | null> {
  return (await getSession())?.credentialId ?? null;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/** Drops expired sessions and challenges. Cheap enough to call on every login. */
export async function pruneExpired(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

/**
 * Ends every live session except the caller's own. Missing cookie means nothing can
 * be identified as "own", so it deletes nothing rather than guessing.
 */
export async function endOtherSessions(): Promise<number> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return 0;

  const deleted = await db
    .delete(sessions)
    .where(and(ne(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .returning({ id: sessions.id });
  return deleted.length;
}

export interface SessionSummary {
  id: string;
  deviceId: string | null;
  lastSeenAt: string | null;
  current: boolean;
}

/** Live sessions — the rows behind the "Anmeldungen" card (issue #1103 AC2). */
export async function listSessions(): Promise<SessionSummary[]> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const currentHash = token ? hashToken(token) : null;

  const rows = await db
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      deviceId: sessions.deviceId,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .where(gt(sessions.expiresAt, new Date()));

  return rows.map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    current: row.tokenHash === currentHash,
  }));
}

export type EndSessionResult = 'deleted' | 'not-found' | 'self';

/**
 * Ends one specific session (issue #1103 AC4). Never the caller's own — that is
 * "App sperren"'s job, not this button's (AC5, the same separation #857 made for
 * "end all others").
 */
export async function endSession(id: string): Promise<EndSessionResult> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const currentHash = token ? hashToken(token) : null;

  const [row] = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row) return 'not-found';
  if (currentHash && row.tokenHash === currentHash) return 'self';

  await db.delete(sessions).where(eq(sessions.id, id));
  return 'deleted';
}

/**
 * Stamps `last_seen_at` on one session, throttled to at most once per hour
 * (issue #1103 AC3) — the goal is an honest "zuletzt gesehen", not a write on
 * every request. The `WHERE` guard is the actual throttle and is race-safe on
 * its own (two concurrent requests racing the guard just both no-op or both
 * write the same `now()`, either is fine); the JS check above it only spares
 * the round trip in the common case where nothing needs to happen.
 */
async function touchLastSeen(sessionId: string, lastSeenAt: Date | null): Promise<void> {
  const throttleBoundary = new Date(Date.now() - LAST_SEEN_THROTTLE_MS);
  if (lastSeenAt && lastSeenAt > throttleBoundary) return;

  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(sessions.id, sessionId), or(isNull(sessions.lastSeenAt), lt(sessions.lastSeenAt, throttleBoundary))));
}

/**
 * The single authorisation gate. Single-user means there is exactly one legitimate
 * subject; every API route checks against it and there is no second path into the data.
 * Throws — route handlers turn this into a 401.
 *
 * A live session is the entire check: getSession() already derives userId from
 * OWNER_USER_ID itself, so comparing it back against OWNER_USER_ID checked nothing —
 * it was always true. Only the owner can mint a session at all (passkey-gated), so
 * "session exists" already is the authorization. A real identity comparison only
 * becomes meaningful once a multi-user rework stores userId on the sessions row.
 */
export async function requireOwner(): Promise<string> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();

  // Route-handler context by construction — the CODEMAP invariant is that every
  // route checks requireOwner(), and only a route handler may write a cookie.
  // Do not call this from a Server Component; getSession() is the read-only half.
  await healDeviceCookie(session.deviceId);
  await touchLastSeen(session.sessionId, session.lastSeenAt);

  return session.userId;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}
