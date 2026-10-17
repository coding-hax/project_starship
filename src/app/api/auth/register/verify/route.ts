import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { enforce } from '@/auth/rate-limit';
import { createSession } from '@/auth/session';
import {
  burnRecoveryCode,
  consumeChallenge,
  hasAnyCredential,
  issueRecoveryCode,
  relyingParty,
} from '@/auth/webauthn';
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
  // (ADR-0031): `userId` says whose account this passkey joins, and a client
  // that could name it could enrol into a stranger's account.
  const { ok, recoveryCodeId, userId } = await consumeChallenge(body.challenge, 'registration');
  if (!ok) {
    return NextResponse.json({ error: 'Challenge abgelaufen.' }, { status: 400 });
  }

  const rp = relyingParty();
  // A recovery-backed verify is never firstCredential, so it never mints a new
  // recovery code — determined before the transaction, same as the credential count.
  const firstCredential = !(await hasAnyCredential());

  // Null `userId` only ever means first setup (register/options). Anything else
  // would be a challenge row that named no account for an installation that
  // already has one — refuse rather than guess which account to join.
  if (!userId && !firstCredential) {
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
  // The first passkey on the installation also creates the account it belongs
  // to — as `admin`, because the only way to become admin is to be first
  // (ADR-0031). Created inside the transaction below, so an abandoned or failed
  // ceremony leaves no empty account behind.
  const targetUserId = userId ?? uuidv7();

  try {
    await db.transaction(async (tx) => {
      if (!userId) {
        await tx.insert(users).values({ id: targetUserId, role: 'admin' });
      }

      if (recoveryCodeId && !(await burnRecoveryCode(recoveryCodeId, tx))) {
        throw new RecoveryCodeAlreadyUsedError();
      }

      await tx.insert(credentials).values({
        id: newCredentialId,
        userId: targetUserId,
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
    throw error;
  }

  await createSession(targetUserId, newCredentialId);

  // The recovery code exists once, at first setup, and is never recoverable again.
  const recoveryCode = firstCredential ? await issueRecoveryCode(targetUserId) : null;
  return NextResponse.json({ verified: true, recoveryCode });
}

class RecoveryCodeAlreadyUsedError extends Error {
  constructor() {
    super('Recovery code already used');
    this.name = 'RecoveryCodeAlreadyUsedError';
  }
}
