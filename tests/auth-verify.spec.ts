import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';

/**
 * Issue #481 (Fund F8, Deep Review 02.08.26). `verifyAuthenticationResponse` /
 * `verifyRegistrationResponse` throw on a malformed or tampered response instead of
 * returning `verified: false` — uncaught, that became a 500. Now both verify routes
 * catch the throw and answer 401, the same message as any other failed verification
 * (AK2: "unknown passkey" and "signature invalid" stay indistinguishable).
 *
 * Runs against the session `auth.setup.ts` already registered — no ceremony, no
 * `resetDatabase`, nothing here succeeds far enough to write to the DB (the register
 * cases throw before the `insert`).
 */

const garbageAuthenticationResponse = (credId: string) => ({
  id: credId,
  rawId: credId,
  type: 'public-key',
  response: {
    clientDataJSON: 'x',
    authenticatorData: 'x',
    signature: 'x',
  },
  clientExtensionResults: {},
});

const garbageRegistrationResponse = () => ({
  id: 'x',
  rawId: 'x',
  type: 'public-key',
  response: {
    clientDataJSON: 'x',
    attestationObject: 'x',
  },
  clientExtensionResults: {},
});

test('AK1a: login/verify mit manipulierter Antwort auf bekanntes Credential liefert 401, nicht 500', async ({
  page,
}) => {
  const optionsRes = await page.request.post('/api/auth/login/options');
  expect(optionsRes.status()).toBe(200);
  const options = (await optionsRes.json()) as PublicKeyCredentialRequestOptionsJSON;
  const credId = options.allowCredentials?.[0]?.id;
  expect(credId).toBeTruthy();

  const verifyRes = await page.request.post('/api/auth/login/verify', {
    data: {
      challenge: options.challenge,
      response: garbageAuthenticationResponse(credId as string),
    },
  });

  expect(verifyRes.status()).not.toBe(500);
  expect(verifyRes.status()).toBe(401);
});

test('AK1b: register/verify mit manipulierter Antwort liefert 401, nicht 500', async ({
  page,
}) => {
  const optionsRes = await page.request.post('/api/auth/register/options', { data: {} });
  expect(optionsRes.status()).toBe(200);
  const options = await optionsRes.json();

  const verifyRes = await page.request.post('/api/auth/register/verify', {
    data: { challenge: options.challenge, response: garbageRegistrationResponse() },
  });

  expect(verifyRes.status()).not.toBe(500);
  expect(verifyRes.status()).toBe(401);
});

test('AK2: unbekannter Passkey und fehlgeschlagene Signatur sind an Status und Meldung nicht unterscheidbar', async ({
  page,
}) => {
  const optionsA = await page.request.post('/api/auth/login/options');
  const { challenge: challengeA } = (await optionsA.json()) as PublicKeyCredentialRequestOptionsJSON;
  const resA = await page.request.post('/api/auth/login/verify', {
    data: { challenge: challengeA, response: garbageAuthenticationResponse(randomUUID()) },
  });
  const bodyA = await resA.json();

  const optionsB = await page.request.post('/api/auth/login/options');
  const optionsBJson = (await optionsB.json()) as PublicKeyCredentialRequestOptionsJSON;
  const credId = optionsBJson.allowCredentials?.[0]?.id as string;
  const resB = await page.request.post('/api/auth/login/verify', {
    data: {
      challenge: optionsBJson.challenge,
      response: garbageAuthenticationResponse(credId),
    },
  });
  const bodyB = await resB.json();

  expect(resA.status()).toBe(401);
  expect(resB.status()).toBe(401);
  expect(bodyA.error).toBe(bodyB.error);
});

test('AK3: der enge catch faengt keine andere Fehlerklasse ab — kaputter Body und tote Challenge bleiben 400', async ({
  page,
}) => {
  const missingResponseRes = await page.request.post('/api/auth/login/verify', {
    data: {},
  });
  expect(missingResponseRes.status()).toBe(400);

  const deadChallengeRes = await page.request.post('/api/auth/login/verify', {
    data: {
      challenge: 'erfundene-oder-abgelaufene-challenge',
      response: garbageAuthenticationResponse(randomUUID()),
    },
  });
  expect(deadChallengeRes.status()).toBe(400);
});
