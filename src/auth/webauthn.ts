import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
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
  recoveryCodeId: string | null = null,
): Promise<void> {
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date()));
  await db.insert(authChallenges).values({
    id: uuidv7(),
    challenge,
    kind,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    recoveryCodeId,
  });
}

/**
 * Consumes the challenge: valid at most once, never after it expired. Carries the
 * recovery-code binding set by `storeChallenge` — that is how `verify` learns a
 * registration is recovery-backed without trusting a code sent again by the client.
 */
export async function consumeChallenge(
  challenge: string,
  kind: 'registration' | 'authentication',
): Promise<{ ok: boolean; recoveryCodeId: string | null }> {
  const [row] = await db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.challenge, challenge))
    .limit(1);

  if (!row) return { ok: false, recoveryCodeId: null };
  await db.delete(authChallenges).where(eq(authChallenges.id, row.id));

  return {
    ok: row.kind === kind && row.expiresAt > new Date(),
    recoveryCodeId: row.recoveryCodeId,
  };
}

export async function listCredentials() {
  return db.select().from(credentials);
}

export async function hasAnyCredential(): Promise<boolean> {
  return (await listCredentials()).length > 0;
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
export async function issueRecoveryCode(): Promise<string> {
  const raw = randomBytes(20)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24)
    .toUpperCase();
  const code = raw.match(/.{1,6}/g)!.join('-');

  await db.insert(recoveryCodes).values({ id: uuidv7(), codeHash: hash(code) });
  return code;
}

/**
 * Checks the code against the stored hashes without burning it — `usedAt` stays
 * untouched. Registration only *starts* here; burning this early would strand the
 * caller with no passkey if the WebAuthn ceremony that follows never completes.
 */
export async function verifyRecoveryCode(code: string): Promise<string | null> {
  const candidates = await db.select().from(recoveryCodes).where(isNull(recoveryCodes.usedAt));
  const incoming = Buffer.from(hash(code.trim().toUpperCase()));

  for (const row of candidates) {
    const stored = Buffer.from(row.codeHash);
    if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) {
      return row.id;
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
