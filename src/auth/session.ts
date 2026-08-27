import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { sessions } from '@/db/schema';
import { SESSION_COOKIE } from './session-cookie';

export { SESSION_COOKIE };

/** Long-lived on purpose: the goal is never having to log in again. */
const SESSION_TTL_DAYS = 365;

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
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    id: uuidv7(),
    tokenHash: hashToken(token),
    expiresAt,
    credentialId,
  });

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
export async function getSession(): Promise<{ userId: string; credentialId: string | null } | null> {
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

  return { userId: ownerId, credentialId: row.credentialId };
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

/** Live sessions other than the current one — the count shown before the "end all" action. */
export async function countOtherSessions(): Promise<number> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return 0;

  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(ne(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return rows.length;
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

  return session.userId;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}
