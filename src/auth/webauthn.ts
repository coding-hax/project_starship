import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { authChallenges, credentials, recoveryCodes } from '@/db/schema';

/** Challenges are single-use and short-lived. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function relyingParty() {
  const id = process.env.RP_ID;
  const name = process.env.RP_NAME ?? 'Starship';
  const origin = process.env.RP_ORIGIN;
  if (!id || !origin) throw new Error('RP_ID and RP_ORIGIN must be set.');
  return { id, name, origin };
}

export async function storeChallenge(
  challenge: string,
  kind: 'registration' | 'authentication',
  binding: { recoveryCodeId?: string | null; userId?: string | null } = {},
): Promise<void> {
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date()));
  await db.insert(authChallenges).values({
    id: uuidv7(),
    challenge,
    kind,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    recoveryCodeId: binding.recoveryCodeId ?? null,
    userId: binding.userId ?? null,
  });
}

/**
 * Consumes the challenge: valid at most once, never after it expired. Single
 * `DELETE ... RETURNING` — matching challenge, `kind` and non-expiry are all part of
 * the `WHERE`, so there is no read-then-delete window two concurrent callers could
 * race through. Carries the recovery-code binding set by `storeChallenge` — that is
 * how `verify` learns a registration is recovery-backed without trusting a code sent
 * again by the client — and, since #1200, the account the registration targets:
 * a client that could name the account could enrol a passkey into a stranger's.
 * `userId: null` means "no account yet", i.e. the very first setup.
 */
export async function consumeChallenge(
  challenge: string,
  kind: 'registration' | 'authentication',
): Promise<{ ok: boolean; recoveryCodeId: string | null; userId: string | null }> {
  const [row] = await db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.challenge, challenge),
        eq(authChallenges.kind, kind),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning({
      recoveryCodeId: authChallenges.recoveryCodeId,
      userId: authChallenges.userId,
    });

  if (!row) return { ok: false, recoveryCodeId: null, userId: null };
  return { ok: true, recoveryCodeId: row.recoveryCodeId, userId: row.userId };
}

export async function listCredentials(userId: string) {
  return db.select().from(credentials).where(eq(credentials.userId, userId));
}

/**
 * Every passkey on the installation, across accounts. Exactly one caller:
 * `login/options`, which has to fill `allowCredentials` before it can possibly
 * know whose account the ceremony belongs to (usernameless WebAuthn). Nothing
 * else may use this — see `listCredentials(userId)`.
 */
export async function listAllCredentials() {
  return db.select().from(credentials);
}

/**
 * Whether *any* account has a passkey. Deliberately not scoped to one account:
 * this is the "is the installation set up at all" question that
 * `/api/auth/status` and the register gate ask before an account is known.
 */
export async function hasAnyCredential(): Promise<boolean> {
  const rows = await db.select({ id: credentials.id }).from(credentials).limit(1);
  return rows.length > 0;
}

/** Passkeys of one account for the devices panel — never the key material itself. */
export async function listCredentialsForDisplay(
  userId: string,
): Promise<Array<{ id: string; label: string | null; createdAt: Date; lastUsedAt: Date | null }>> {
  const rows = await db
    .select({
      id: credentials.id,
      label: credentials.label,
      createdAt: credentials.createdAt,
      lastUsedAt: credentials.lastUsedAt,
    })
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .orderBy(credentials.createdAt);
  return rows;
}

export type RevokeCredentialResult = 'deleted' | 'not-found' | 'last-credential';

/**
 * Revokes a passkey of `userId`. `FOR UPDATE` locks that account's credential rows
 * for the duration of the transaction, so two concurrent revokes serialize: the
 * second one re-reads the already-reduced set and is the one that hits
 * `last-credential`, guaranteeing the last passkey can never be deleted out from
 * under the caller (self-lockout guard). The delete below also ends that device's
 * sessions atomically, in the same transaction, via `ON DELETE CASCADE` on
 * `sessions.credential_id` (issue #854).
 *
 * A credential of another account reads as `not-found`, never as deletable: the
 * `userId` filter is inside the locked read, not bolted on afterwards.
 */
export async function revokeCredential(
  userId: string,
  id: string,
): Promise<RevokeCredentialResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.userId, userId))
      .for('update');

    if (!rows.some((row) => row.id === id)) return 'not-found';
    if (rows.length <= 1) return 'last-credential';

    await tx.delete(credentials).where(and(eq(credentials.id, id), eq(credentials.userId, userId)));
    return 'deleted';
  });
}

/** Renames a passkey of `userId`. `false` if that account has no such credential. */
export async function renameCredential(
  userId: string,
  id: string,
  label: string | null,
): Promise<boolean> {
  const updated = await db
    .update(credentials)
    .set({ label })
    .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
    .returning({ id: credentials.id });
  return updated.length === 1;
}

/* --------------------------------- recovery -------------------------------- */

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Generates the recovery code and stores only its hash. Returned in clear exactly
 * once — the caller shows it and then it is gone for good (ADR-0001: passphrase lost
 * = journal lost; the same discipline applies here).
 */
export async function issueRecoveryCode(userId: string): Promise<string> {
  const raw = randomBytes(20)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24)
    .toUpperCase();
  const code = raw.match(/.{1,6}/g)!.join('-');

  await db.insert(recoveryCodes).values({ id: uuidv7(), userId, codeHash: hash(code) });
  return code;
}

/**
 * Checks the code against the stored hashes without burning it — `usedAt` stays
 * untouched. Registration only *starts* here; burning this early would strand the
 * caller with no passkey if the WebAuthn ceremony that follows never completes.
 */
export async function verifyRecoveryCode(
  code: string,
): Promise<{ id: string; userId: string } | null> {
  const candidates = await db.select().from(recoveryCodes).where(isNull(recoveryCodes.usedAt));
  const incoming = Buffer.from(hash(code.trim().toUpperCase()));

  for (const row of candidates) {
    const stored = Buffer.from(row.codeHash);
    if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) {
      // The account the code belongs to — a recovery code is presented without a
      // session, so it has to carry the identity itself (ADR-0031).
      return { id: row.id, userId: row.userId };
    }
  }
  return null;
}

/**
 * Burns the code — a recovery code works once. Conditioned on `isNull(usedAt)` and
 * checked via `returning` (not read-then-write) so two concurrent ceremonies with
 * the same code can never both succeed. Pass `exec` to run inside the same
 * transaction as the credential insert it gates.
 */
export async function burnRecoveryCode(
  id: string,
  exec: Pick<typeof db, 'update'> = db,
): Promise<boolean> {
  const burned = await exec
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.id, id), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id });
  return burned.length === 1;
}
