import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { sessions } from '@/db/schema';

export const SESSION_COOKIE = 'starship_session';

/** Long-lived on purpose: the goal is never having to log in again. */
const SESSION_TTL_DAYS = 365;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a session and sets the cookie. The raw token is returned to the browser
 * once, inside the cookie; the database only ever sees its hash.
 */
export async function createSession(): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    id: uuidv7(),
    tokenHash: hashToken(token),
    expiresAt,
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
export async function getSession(): Promise<{ userId: string } | null> {
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

  return { userId: ownerId };
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
 * The single authorisation gate. Single-user means there is exactly one legitimate
 * subject; every API route checks against it and there is no second path into the data.
 * Throws — route handlers turn this into a 401.
 */
export async function requireOwner(): Promise<string> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();

  const ownerId = process.env.OWNER_USER_ID;
  if (!ownerId) throw new Error('OWNER_USER_ID is not set.');

  const a = Buffer.from(session.userId);
  const b = Buffer.from(ownerId);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedError();

  return ownerId;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}
