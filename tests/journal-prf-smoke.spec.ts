import { expect, test } from '@playwright/test';
import { enableVirtualAuthenticator } from './helpers';

/**
 * Phase 0 of #511: proves Chrome's virtual authenticator (CDP `WebAuthn` domain)
 * actually speaks the PRF extension before any crypto/UI work is built on top of
 * it. This is a hard gate from the plan, not an acceptance criterion — if this
 * goes red, the PRF-based unlock approach is not testable in this harness and the
 * ticket needs re-evaluation, not a workaround here.
 *
 * Registers a real credential with `extensions: { prf: {} }`, then runs two
 * separate assertions with the same salt and checks that `prf.results.first` is
 * (a) present and (b) identical both times — the property the journal's KEK
 * derivation depends on (same salt -> same secret -> same derived key).
 */
test('virtueller Authenticator liefert stabile PRF-Resultate ueber zwei Assertions (Phase 0)', async ({
  page,
}) => {
  await enableVirtualAuthenticator(page);
  await page.goto('/anmelden');

  const result = await page.evaluate(async () => {
    function randomBuffer(length: number): ArrayBuffer {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes.buffer;
    }
    function bufferToBase64(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }

    const userId = randomBuffer(16);
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Starship Test', id: location.hostname },
        user: { id: userId, name: 'phase0', displayName: 'Phase 0' },
        challenge: randomBuffer(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} },
      },
    })) as PublicKeyCredential;

    const creationExtensions = credential.getClientExtensionResults() as {
      prf?: { enabled?: boolean };
    };

    const salt = randomBuffer(32);

    async function assertOnce() {
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: randomBuffer(32),
          userVerification: 'required',
          extensions: { prf: { eval: { first: salt } } },
        },
      })) as PublicKeyCredential;
      const extensions = assertion.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      const first = extensions.prf?.results?.first;
      return first ? bufferToBase64(first) : null;
    }

    const firstResult = await assertOnce();
    const secondResult = await assertOnce();

    return {
      prfEnabledAtCreation: creationExtensions.prf?.enabled ?? null,
      firstResult,
      secondResult,
    };
  });

  expect(result.firstResult).not.toBeNull();
  expect(result.firstResult).toBe(result.secondResult);
});
