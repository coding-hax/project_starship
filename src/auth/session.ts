import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';
import { recordActivity, recordActivityWindow } from './activity';
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
 * Mints a session for `userId` and sets the cookie. The raw token is returned to
 * the browser once, inside the cookie; the database only ever sees its hash.
 * `credentialId` binds the session to the passkey that minted it (issue #854) —
 * omitted for the throwaway/legacy paths that have no credential to bind to.
 *
 * `userId` is not optional and has no default on purpose (ADR-0031): every caller
 * has to say whose session this is, and the compiler asks.
 */
export async function createSession(
  userId: string,
  credentialId: string | null = null,
): Promise<void> {
  const id = uuidv7();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const deviceId = await ensureDeviceId();

  await db.insert(sessions).values({
    id,
    userId,
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
          eq(sessions.userId, userId),
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

/** Who the request is, once a live session has been resolved (ADR-0031). */
export interface SessionUser {
  userId: string;
  role: 'admin' | 'user';
  sessionId: string;
  credentialId: string | null;
  deviceId: string | null;
  lastSeenAt: Date | null;
  /** The *account's* `users.last_seen_at` (S4, #1203 AK3) — distinct from `lastSeenAt`
   * above, which is this *session's* own throttled stamp. `recordActivity()` needs
   * this one to decide whether its own hourly throttle is still open. */
  userLastSeenAt: Date | null;
  /** Set while the account is locked — `requireUser()` turns this into a 403. */
  blockedAt: Date | null;
}

/**
 * The account behind the request, or null when there is no live session.
 *
 * The join is what changed with ADR-0031: the identity comes out of the
 * `sessions` row, not out of an environment variable. The pre-#1200 version
 * read a single owner id out of the environment and then compared it back
 * against itself, which checked nothing — it was always true.
 *
 * A blocked account still resolves here. Separating "who are you" from "may you"
 * is what lets `requireUser()` answer 403 instead of 401, so the client can tell
 * a lock from a logout (#1201, S2) instead of silently wiping the device.
 */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({
      userId: users.id,
      role: users.role,
      blockedAt: users.blockedAt,
      userLastSeenAt: users.lastSeenAt,
      sessionId: sessions.id,
      credentialId: sessions.credentialId,
      deviceId: sessions.deviceId,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return row ?? null;
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
 * Ends every live session of `userId` except the caller's own. Missing cookie
 * means nothing can be identified as "own", so it deletes nothing rather than
 * guessing — and the account filter means it can never reach a second account.
 */
export async function endOtherSessions(userId: string): Promise<number> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return 0;

  const deleted = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .returning({ id: sessions.id });
  return deleted.length;
}

/**
 * Ends every live session of `userId`, no exception (S5, #1204 AK1) —
 * unlike `endOtherSessions` above, the caller here is an admin acting on a
 * *different* account, so there is no "own" session to spare. Optional
 * `exec` (same contract as `burnInvite`) lets `blockAccount()` run this in
 * the same transaction as the `blocked_at` write, so a crash between the two
 * can never leave a blocked account with a live session.
 */
export async function endAllSessions(
  userId: string,
  exec: Pick<typeof db, 'delete'> = db,
): Promise<number> {
  const deleted = await exec
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return deleted.length;
}

export interface SessionSummary {
  id: string;
  deviceId: string | null;
  lastSeenAt: string | null;
  current: boolean;
}

/** Live sessions of one account — the rows behind the "Anmeldungen" card (issue #1103 AC2). */
export async function listSessions(userId: string): Promise<SessionSummary[]> {
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
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));

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
export async function endSession(userId: string, id: string): Promise<EndSessionResult> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const currentHash = token ? hashToken(token) : null;

  // The account filter sits in the lookup, not after it: another account's
  // session reads as `not-found`, which is also the honest answer to give —
  // revealing that the id exists would leak that a second account has it.
  const [row] = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .limit(1);
  if (!row) return 'not-found';
  if (currentHash && row.tokenHash === currentHash) return 'self';

  await db.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
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
 * The single authorisation gate (ADR-0031). Every route that touches `@/db`
 * calls it and scopes every query to the `userId` it returns;
 * `scripts/check-tenant-isolation.sh` keeps that honest.
 *
 * Returns the account instead of a bare id, because callers need the role
 * (/admin) and because a bare string invites passing the wrong one.
 *
 * The two throws mean different things to the client, and that difference is
 * load-bearing:
 * - `UnauthorizedError` → 401, "there is no session". The client wipes its local
 *   database and goes to /anmelden.
 * - `AccountBlockedError` → 403, "there is a session, the account is locked".
 *   The client stops syncing and **keeps** its data — a lock is not a delete.
 * `authErrorResponse()` (src/auth/auth-response.ts) is the one place that turns
 * them into HTTP, so no route has to get that mapping right on its own.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  if (session.blockedAt) throw new AccountBlockedError();

  // Route-handler context by construction — the CODEMAP invariant is that every
  // route checks requireUser(), and only a route handler may write a cookie.
  // Do not call this from a Server Component; getSession() is the read-only half.
  await healDeviceCookie(session.deviceId);
  await touchLastSeen(session.sessionId, session.lastSeenAt);
  await recordActivity(session.userId, session.userLastSeenAt);
  // 5-minute Neon wake-time window (#1233 AK1) — independent of the hourly
  // throttle above, and never throws on its own (AK2), so no guard is needed here.
  await recordActivityWindow(session.userId);

  return session;
}

/**
 * `requireUser()` plus the one extra check /admin needs (S4, #1203 AK1): the
 * account exists and is signed in (otherwise `requireUser()` already threw), but
 * is not `role: 'admin'`. `authErrorResponse()` maps this to 404, not 403 — the
 * existence of /admin is not information a non-admin account gets to have.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const session = await requireUser();
  if (session.role !== 'admin') throw new NotAdminError();
  return session;
}

/**
 * The single admin account, or null while none exists. The bootstrap account the
 * migration creates and the CLI bootstrap (#1202, S3) find each other through
 * this — there is no second way to become admin.
 */
export async function findAdminUserId(): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  return row?.id ?? null;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/** A live session on a locked account (`users.blocked_at`) — 403, never 401. */
export class AccountBlockedError extends Error {
  constructor() {
    super('Account blocked');
    this.name = 'AccountBlockedError';
  }
}

/** A live, unblocked session on a `role: 'user'` account reaching an admin-only
 * route — 404, never 403 (AK1): see `requireAdmin()` above. */
export class NotAdminError extends Error {
  constructor() {
    super('Not admin');
    this.name = 'NotAdminError';
  }
}
