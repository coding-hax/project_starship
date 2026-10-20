import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { NextResponse } from 'next/server';
import { guardAdmin } from '@/auth/admin-route';
import { listCredentials, relyingParty, storeChallenge } from '@/auth/webauthn';

/**
 * Starts the step-up ceremony (#1224 AK10) for the admin's own passkeys —
 * `allowCredentials` only ever lists the caller's own credentials, never
 * every credential on the installation the way the usernameless login flow
 * does (`login/options`): a step-up re-confirms the signed-in account, it
 * does not need to discover which account is signing in.
 */
export async function POST(request: Request) {
  const guard = await guardAdmin(request, { mutating: false });
  if ('error' in guard) return guard.error;
  const { admin } = guard;

  const rp = relyingParty();
  const own = await listCredentials(admin.userId);

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: own.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransport[],
    })),
    userVerification: 'required',
  });

  await storeChallenge(options.challenge, 'step-up', { userId: admin.userId });
  return NextResponse.json(options);
}

type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
