import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { credentials } from '@/db/schema';
import type { SessionUser } from './session';
import { consumeChallenge, relyingParty } from './webauthn';

/**
 * Freshness gate for an irreversible admin action (#1224 AK10): "Journal
 * löschen", "Konto löschen" and "Zugang neu ausstellen" call this after
 * `guardAdmin()` and refuse the request outright if it returns `false`. Reuses
 * the ordinary WebAuthn authentication ceremony rather than a second auth
 * stack — `storeChallenge`/`consumeChallenge`'s existing `CHALLENGE_TTL_MS`
 * (5 minutes) and single-use delete are what make the confirmation "fresh";
 * `userVerification: 'required'` (checked below via `userVerified`) is what
 * makes it a real Face ID/Touch ID/PIN prompt rather than a bare tap.
 *
 * Every failure returns `false` rather than throwing — a stolen session or an
 * unlocked, left-open device fails the ceremony the same way a wrong
 * assertion would, with no detail to distinguish the two.
 */
export async function verifyStepUp(request: Request, admin: SessionUser): Promise<boolean> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.challenge !== 'string' || !body.assertion) return false;
  const assertion = body.assertion as AuthenticationResponseJSON;

  const challengeRow = await consumeChallenge(body.challenge, 'step-up');
  if (!challengeRow.ok || challengeRow.userId !== admin.userId) return false;

  const [credential] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, assertion.id))
    .limit(1);
  if (!credential || credential.userId !== admin.userId) return false;

  const rp = relyingParty();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: body.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
        counter: credential.counter,
        transports: credential.transports as never,
      },
      requireUserVerification: true,
    });
  } catch {
    return false;
  }

  if (!verification.verified || !verification.authenticationInfo.userVerified) return false;

  await db
    .update(credentials)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(credentials.id, credential.id));

  return true;
}
