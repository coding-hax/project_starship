import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { db } from '@/db';
import { adminAudit, credentials, journalEntries, journalKeys, sessions, users } from '@/db/schema';
import { createInvite } from '@/auth/invite';
import { endAllSessions } from '@/auth/session';
import { relyingParty } from '@/auth/webauthn';

/**
 * The five destructive/administrative actions /admin can take on another
 * account (S5, #1204). Each wraps its effect and exactly one `admin_audit`
 * insert in one `db.transaction` (AK8) — there is no code path that performs
 * the effect without the audit row, or the reverse.
 *
 * None of these ever reads or returns a content field (title, ciphertext) —
 * AK9, same discipline as `getAccountsOverview()` (S4, #1203 AK8).
 */

type ActionResult = 'ok' | 'self' | 'not-found';

async function auditLabelOf(exec: Pick<typeof db, 'select'>, userId: string): Promise<string | null> {
  const [row] = await exec.select({ label: users.displayName }).from(users).where(eq(users.id, userId));
  return row?.label ?? null;
}

async function insertAudit(
  tx: Pick<typeof db, 'insert'>,
  action: (typeof adminAudit.$inferInsert)['action'],
  adminId: string,
  adminLabel: string | null,
  targetId: string,
  targetLabel: string | null,
): Promise<void> {
  await tx.insert(adminAudit).values({
    id: uuidv7(),
    actorUserId: adminId,
    actorLabel: adminLabel,
    targetUserId: targetId,
    targetLabel,
    action,
  });
}

/**
 * Locks `targetId` (AK1): sets `blocked_at` and ends every one of its
 * sessions, in the same transaction — a crash between the two can never
 * leave a blocked account still logged in anywhere. The account's rows stay
 * untouched; `requireUser()` is what turns the lock into a 403 on the
 * target's next request.
 */
export async function blockAccount(adminId: string, targetId: string): Promise<ActionResult> {
  if (targetId === adminId) return 'self';

  return db.transaction(async (tx) => {
    const [adminLabel, targetLabel] = await Promise.all([
      auditLabelOf(tx, adminId),
      auditLabelOf(tx, targetId),
    ]);

    const updated = await tx
      .update(users)
      .set({ blockedAt: new Date() })
      .where(eq(users.id, targetId))
      .returning({ id: users.id });
    if (updated.length === 0) return 'not-found';

    await endAllSessions(targetId, tx);
    await insertAudit(tx, 'block', adminId, adminLabel, targetId, targetLabel);
    return 'ok';
  });
}

/**
 * Unlocks `targetId` (AK2): clears `blocked_at`. No session change — the
 * account signs back in with its existing passkey, nothing was revoked.
 */
export async function unblockAccount(adminId: string, targetId: string): Promise<ActionResult> {
  if (targetId === adminId) return 'self';

  return db.transaction(async (tx) => {
    const [adminLabel, targetLabel] = await Promise.all([
      auditLabelOf(tx, adminId),
      auditLabelOf(tx, targetId),
    ]);

    const updated = await tx
      .update(users)
      .set({ blockedAt: null })
      .where(eq(users.id, targetId))
      .returning({ id: users.id });
    if (updated.length === 0) return 'not-found';

    await insertAudit(tx, 'unblock', adminId, adminLabel, targetId, targetLabel);
    return 'ok';
  });
}

export type ReissueResult =
  | { status: 'ok'; link: string }
  | { status: 'self' }
  | { status: 'not-found' };

/**
 * Revokes every passkey and session of `targetId` and mints a fresh invite
 * bound to that same account (AK3) — all in one transaction, so a crash
 * between the revoke and the invite can never strand the account with
 * neither a passkey nor a way back in. The plaintext link is returned
 * exactly once; the database only ever sees its hash (`createInvite`).
 */
export async function reissueAccess(adminId: string, targetId: string): Promise<ReissueResult> {
  if (targetId === adminId) return { status: 'self' };

  return db.transaction(async (tx) => {
    const [adminLabel, target] = await Promise.all([
      auditLabelOf(tx, adminId),
      tx.select({ label: users.displayName }).from(users).where(eq(users.id, targetId)),
    ]);
    if (target.length === 0) return { status: 'not-found' };
    const targetLabel = target[0].label;

    await tx.delete(credentials).where(eq(credentials.userId, targetId));
    await tx.delete(sessions).where(eq(sessions.userId, targetId));
    const { token } = await createInvite({ createdBy: adminId, userId: targetId }, tx);
    await insertAudit(tx, 'reissue', adminId, adminLabel, targetId, targetLabel);

    const { origin } = relyingParty();
    return { status: 'ok', link: `${origin}/einladung/${token}` };
  });
}

/**
 * Hard-deletes the Journal of `targetId` (AK4) — no tombstone: a soft delete
 * heals itself the moment any other device syncs the row back (Memory
 * "journal-reset-needs-hard-delete"). The server never reads `ciphertext`
 * either way (ADR-0004); this only ever deletes by `user_id`.
 */
export async function deleteJournal(adminId: string, targetId: string): Promise<ActionResult> {
  if (targetId === adminId) return 'self';

  return db.transaction(async (tx) => {
    const [adminLabel, target] = await Promise.all([
      auditLabelOf(tx, adminId),
      tx.select({ label: users.displayName }).from(users).where(eq(users.id, targetId)),
    ]);
    if (target.length === 0) return 'not-found';
    const targetLabel = target[0].label;

    await tx.delete(journalEntries).where(eq(journalEntries.userId, targetId));
    await tx.delete(journalKeys).where(eq(journalKeys.userId, targetId));
    await insertAudit(tx, 'delete-journal', adminId, adminLabel, targetId, targetLabel);
    return 'ok';
  });
}

export type DeleteAccountResult = 'ok' | 'self' | 'not-found' | 'last-admin';

/**
 * Hard-deletes `targetId` (AK5): every row it owns disappears through
 * `ON DELETE CASCADE` on `user_id` (ADR-0031) in the same transaction as the
 * `users` delete itself. The audit row is inserted first, but survives the
 * delete regardless — its FK is `ON DELETE SET NULL`, not cascade (see
 * `src/db/schema.ts`).
 *
 * `FOR UPDATE` on the admin rows (AK7) mirrors `revokeCredential`'s
 * `last-credential` guard: it locks every admin account for the duration of
 * the transaction, so two concurrent deletes of two different admins
 * serialise instead of racing past a stale count — the second one re-reads
 * the already-reduced set and is the one that hits `last-admin`.
 */
export async function deleteAccount(adminId: string, targetId: string): Promise<DeleteAccountResult> {
  if (targetId === adminId) return 'self';

  return db.transaction(async (tx) => {
    const [adminLabel, target] = await Promise.all([
      auditLabelOf(tx, adminId),
      tx.select({ label: users.displayName, role: users.role }).from(users).where(eq(users.id, targetId)),
    ]);
    if (target.length === 0) return 'not-found';
    const targetLabel = target[0].label;

    if (target[0].role === 'admin') {
      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).for('update');
      if (admins.length <= 1) return 'last-admin';
    }

    await insertAudit(tx, 'delete-account', adminId, adminLabel, targetId, targetLabel);
    await tx.delete(users).where(eq(users.id, targetId));
    return 'ok';
  });
}
