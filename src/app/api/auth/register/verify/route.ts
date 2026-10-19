import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { burnInvite } from '@/auth/invite';
import { enforce } from '@/auth/rate-limit';
import { createSession } from '@/auth/session';
import { burnRecoveryCode, consumeChallenge, issueRecoveryCode, relyingParty } from '@/auth/webauthn';
import { db } from '@/db';
import { credentials, users } from '@/db/schema';

export async function POST(request: Request) {
  // Belt and suspenders — the single-use challenge from register/options is the
  // real gate here; this is the shared options budget, not a second bucket.
  const limited = await enforce(request, 'options');
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  if (!body?.response || typeof body.challenge !== 'string') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  // Both bindings come from the challenge row, never from the request body
  // (ADR-0031): `userId`/`inviteId` say whose account (or which invite) this
  // passkey joins, and a client that could name either could enrol into a
  // stranger's account.
  const { ok, recoveryCodeId, inviteId, userId } = await consumeChallenge(
    body.challenge,
    'registration',
  );
  if (!ok) {
    return NextResponse.json({ error: 'Challenge abgelaufen.' }, { status: 400 });
  }

  const rp = relyingParty();
  // Only the bootstrap admin's own invite pre-binds an account to an invite
  // (`scripts/bootstrap-admin.ts`) — a fresh user-invite has `inviteId` but no
  // `userId`, a second device or recovery has `userId` but no `inviteId`. Not
  // `hasAnyCredential()`: an admin account can exist (e.g. seeded directly)
  // before it ever registers its own passkey, which would otherwise make an
  // unrelated invite's first redemption look like the bootstrap one.
  const firstCredential = Boolean(userId) && Boolean(inviteId);

  // Neither an account nor an invite named — the AK5 gate from register/options
  // stripped the old "empty database" exception; refuse rather than guess.
  if (!userId && !inviteId) {
    return NextResponse.json({ error: 'Registrierung nicht erlaubt.' }, { status: 403 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: body.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
    });
  } catch {
    // The library throws on a malformed/tampered response instead of returning
    // verified: false (AK1). Distinct from the !verified branch below, which
    // stays 400 — that's an existing, intentionally unchanged behavior (see PR).
    return NextResponse.json(
      { error: 'Passkey konnte nicht verifiziert werden.' },
      { status: 401 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json(
      { error: 'Passkey konnte nicht verifiziert werden.' },
      { status: 400 },
    );
  }

  const { credential } = verification.registrationInfo;
  const newCredentialId = uuidv7();
  // A pending invite (no account yet) mints one inside the transaction below, so
  // an abandoned or failed ceremony leaves no empty account behind.
  const provisionalUserId = userId ?? uuidv7();
  // Set inside the transaction — a pre-bound invite (the bootstrap admin) points
  // at an *existing* account, not `provisionalUserId`, so the actual target is
  // only known once `burnInvite` returns.
  let finalUserId = provisionalUserId;

  try {
    await db.transaction(async (tx) => {
      if (!userId) {
        // A fresh user-invite redemption — no pre-bound account, so this ceremony
        // mints one (role 'user': the only way to become 'admin' is through
        // `scripts/bootstrap-admin.ts`, AK6). Must happen before `burnInvite`
        // below: that call points `invites.user_id` at `provisionalUserId`,
        // which would violate the FK if the row didn't exist yet.
        await tx.insert(users).values({ id: finalUserId, role: 'user' });
      }

      if (inviteId) {
        // AK3: the one conditional UPDATE … RETURNING that makes the token
        // single-use under concurrency — two simultaneous ceremonies with the
        // same invite can each hold a valid challenge, but only one `UPDATE`
        // here affects a row.
        const burned = await burnInvite(inviteId, provisionalUserId, tx);
        if (!burned) throw new InviteAlreadyUsedError();
        finalUserId = burned.userId;
      }

      if (recoveryCodeId && !(await burnRecoveryCode(recoveryCodeId, tx))) {
        throw new RecoveryCodeAlreadyUsedError();
      }

      await tx.insert(credentials).values({
        id: newCredentialId,
        userId: finalUserId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label: typeof body.label === 'string' ? body.label : null,
      });
    });
  } catch (error) {
    if (error instanceof RecoveryCodeAlreadyUsedError) {
      return NextResponse.json({ error: 'Recovery-Code bereits verbraucht.' }, { status: 403 });
    }
    if (error instanceof InviteAlreadyUsedError) {
      return NextResponse.json(
        { error: 'Diese Einladung ist ungültig oder abgelaufen.' },
        { status: 403 },
      );
    }
    throw error;
  }

  await createSession(finalUserId, newCredentialId);

  // The recovery code exists once, at first setup (the bootstrap admin's own
  // invite), and is never recoverable again.
  const recoveryCode = firstCredential ? await issueRecoveryCode(finalUserId) : null;
  return NextResponse.json({ verified: true, recoveryCode });
}

class RecoveryCodeAlreadyUsedError extends Error {
  constructor() {
    super('Recovery code already used');
    this.name = 'RecoveryCodeAlreadyUsedError';
  }
}

class InviteAlreadyUsedError extends Error {
  constructor() {
    super('Invite already used');
    this.name = 'InviteAlreadyUsedError';
  }
}
