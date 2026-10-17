import { generateRegistrationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { uuidv7 } from 'uuidv7';
import { enforce, noteRecoveryFailure, recoveryBlocked } from '@/auth/rate-limit';
import { getSession } from '@/auth/session';
import {
  hasAnyCredential,
  listCredentials,
  relyingParty,
  storeChallenge,
  verifyRecoveryCode,
} from '@/auth/webauthn';

/**
 * Registration is only ever open in three cases:
 *   1. first setup — no credential exists yet,
 *   2. adding a second device from an already authenticated session,
 *   3. recovery — a valid, unused recovery code.
 * Anything else and a stranger could enrol their own passkey.
 */
export async function POST(request: Request) {
  const limited = await enforce(request, 'options');
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const recoveryCode: unknown = body?.recoveryCode;
  const wantsRecovery = typeof recoveryCode === 'string' && recoveryCode.length > 0;

  if (wantsRecovery) {
    const recoveryLimited = await recoveryBlocked(request);
    if (recoveryLimited) return recoveryLimited;
  }

  const firstSetup = !(await hasAnyCredential());
  const session = await getSession();
  const authenticated = session !== null;
  const recovery = wantsRecovery ? await verifyRecoveryCode(recoveryCode as string) : null;
  const recovered = recovery !== null;

  if (wantsRecovery && !recovered) {
    await noteRecoveryFailure(request);
  }

  if (!firstSetup && !authenticated && !recovered) {
    return NextResponse.json({ error: 'Registrierung nicht erlaubt.' }, { status: 403 });
  }

  // Which account this passkey will belong to, decided here and carried in the
  // challenge row (ADR-0031) — never taken from the request body in `verify`.
  // Null is the first-setup case: `verify` creates the admin account inside the
  // same transaction as the credential, so an abandoned ceremony leaves no
  // empty account behind.
  const targetUserId = session?.userId ?? recovery?.userId ?? null;

  const rp = relyingParty();
  // `userID` is WebAuthn's opaque handle, and the platform keys its stored
  // passkey on it: it has to be the account, not a constant, or two accounts on
  // one device would overwrite each other's entry in the keychain.
  const userHandle = targetUserId ?? uuidv7();

  // `excludeCredentials` stops the *same authenticator* registering twice. For an
  // existing account that is its own passkeys; for a first setup there are none.
  // Deliberately not every account's credentials: that would tell an
  // unauthenticated caller which authenticators exist on the installation.
  const existing = targetUserId ? await listCredentials(targetUserId) : [];
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: new TextEncoder().encode(userHandle),
    userName: 'starship',
    userDisplayName: 'Starship',
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });

  await storeChallenge(options.challenge, 'registration', {
    recoveryCodeId: recovery?.id ?? null,
    userId: targetUserId,
  });
  return NextResponse.json(options);
}
