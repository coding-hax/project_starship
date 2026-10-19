import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { invites } from '@/db/schema';

/** An invite link is valid for 7 days unless the caller says otherwise. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Creates an invite and returns the plaintext token exactly once (AK1) —
 * the database only ever sees `hash(token)`, same discipline as
 * `issueRecoveryCode`/`createSession`.
 *
 * `userId` is omitted for the ordinary case (a fresh account is minted when
 * the invite is redeemed) and set by `scripts/bootstrap-admin.ts` to
 * pre-bind the invite to the admin account it just created — see
 * `src/db/schema.ts`'s doc comment on `invites.userId`.
 */
export async function createInvite({
  createdBy,
  userId = null,
  label = null,
  ttlMs = DEFAULT_TTL_MS,
}: {
  createdBy: string;
  userId?: string | null;
  label?: string | null;
  ttlMs?: number;
}): Promise<{ id: string; token: string }> {
  const id = uuidv7();
  const token = randomBytes(32).toString('base64url');

  await db.insert(invites).values({
    id,
    tokenHash: hash(token),
    createdBy,
    label,
    userId,
    expiresAt: new Date(Date.now() + ttlMs),
  });

  return { id, token };
}

/**
 * Checks the token against the stored hash without burning it — mirrors
 * `verifyRecoveryCode`: burning here would strand the invitee with no
 * passkey if the WebAuthn ceremony that follows never completes.
 *
 * Unknown and expired both read as `null` (AK4) — the caller must not be
 * able to tell the two apart, or an attacker learns whether a token ever
 * existed.
 */
export async function verifyInvite(token: string): Promise<{ id: string; userId: string | null } | null> {
  const [row] = await db
    .select({ id: invites.id, userId: invites.userId })
    .from(invites)
    .where(
      and(eq(invites.tokenHash, hash(token)), isNull(invites.usedAt), gt(invites.expiresAt, new Date())),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Burns the invite — it works once (AK3). Conditioned on `used_at IS NULL`
 * and checked via `returning` (not read-then-write), same pattern as
 * `burnRecoveryCode`, so two concurrent ceremonies with the same token can
 * never both succeed: only one `UPDATE` touches a row, the other gets zero
 * rows back and its transaction rolls back.
 *
 * `user_id` is set to `newUserId` only if the invite did not already carry
 * one (`COALESCE`) — a pre-bound admin invite (`scripts/bootstrap-admin.ts`)
 * keeps pointing at the account it was issued for, never the handle `verify`
 * generated for the ceremony. The returned `userId` is always the final,
 * correct account to attach the credential to.
 *
 * Pass `exec` to run inside the same transaction as the credential insert
 * it gates (same contract as `burnRecoveryCode`).
 */
export async function burnInvite(
  id: string,
  newUserId: string,
  exec: Pick<typeof db, 'update'> = db,
): Promise<{ userId: string } | null> {
  const [row] = await exec
    .update(invites)
    .set({ usedAt: new Date(), userId: sql`coalesce(${invites.userId}, ${newUserId})` })
    .where(and(eq(invites.id, id), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
    .returning({ userId: invites.userId });

  if (!row) return null;
  return { userId: row.userId ?? newUserId };
}
