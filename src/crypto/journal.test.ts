import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, deriveKek, openEnvelope, type Envelope } from './envelope';
import { decryptJournal, encryptJournal, type JournalContent } from './journal';
import { WrongPassphraseError, JournalDecryptError } from './errors';
import { base64ToBytes, bytesToBase64 } from './base64';
import fixture from './__fixtures__/journal-vector.json';

const PASSPHRASE = 'correct horse battery staple';

// DEFAULT_KDF_PARAMS (600_000 PBKDF2 iterations) is deliberately expensive (OWASP
// guidance) — real production cost, not a test concern. Tests that exercise the
// wrap/unwrap logic itself (rather than the default iteration count, covered by AC2)
// use a much cheaper iteration count so the suite stays fast under parallel load.
const FAST_KDF_PARAMS = { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 } as const;

async function makeEnvelopeAndDek(passphrase = PASSPHRASE) {
  const envelope = await createEnvelope(passphrase, FAST_KDF_PARAMS);
  const dek = await openEnvelope(envelope, passphrase);
  return { envelope, dek };
}

describe('deriveKek', () => {
  it('AC1: same passphrase + salt derive a KEK that unwraps a DEK wrapped by an equal derivation', async () => {
    const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const kdfParams = { ...FAST_KDF_PARAMS, salt };

    const kekA = await deriveKek(PASSPHRASE, kdfParams);
    const kekB = await deriveKek(PASSPHRASE, kdfParams);

    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey('raw', dek, kekA, { name: 'AES-GCM', iv: nonce });

    await expect(
      crypto.subtle.unwrapKey(
        'raw',
        wrapped,
        kekB,
        { name: 'AES-GCM', iv: nonce },
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    ).resolves.toBeDefined();
  });

  it('AC1: different salt fails to unwrap', async () => {
    const saltA = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const saltB = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const kekA = await deriveKek(PASSPHRASE, { ...FAST_KDF_PARAMS, salt: saltA });
    const kekB = await deriveKek(PASSPHRASE, { ...FAST_KDF_PARAMS, salt: saltB });

    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey('raw', dek, kekA, { name: 'AES-GCM', iv: nonce });

    await expect(
      crypto.subtle.unwrapKey(
        'raw',
        wrapped,
        kekB,
        { name: 'AES-GCM', iv: nonce },
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow();
  });

  it('AC1: different passphrase fails to unwrap', async () => {
    const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const kdfParams = { ...FAST_KDF_PARAMS, salt };
    const kekA = await deriveKek(PASSPHRASE, kdfParams);
    const kekB = await deriveKek('a different passphrase', kdfParams);

    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey('raw', dek, kekA, { name: 'AES-GCM', iv: nonce });

    await expect(
      crypto.subtle.unwrapKey(
        'raw',
        wrapped,
        kekB,
        { name: 'AES-GCM', iv: nonce },
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow();
  });
});

describe('createEnvelope', () => {
  it('AC2: returns a serializable envelope with all base64 fields decodable, round-trips through JSON', async () => {
    const envelope = await createEnvelope(PASSPHRASE);

    expect(envelope.v).toBe(1);
    expect(envelope.kdfParams.name).toBe('PBKDF2');
    expect(envelope.kdfParams.hash).toBe('SHA-256');
    expect(envelope.kdfParams.iterations).toBeGreaterThan(0);
    expect(() => base64ToBytes(envelope.kdfParams.salt)).not.toThrow();
    expect(() => base64ToBytes(envelope.wrappedDek)).not.toThrow();
    expect(() => base64ToBytes(envelope.nonce)).not.toThrow();

    const roundtripped = JSON.parse(JSON.stringify(envelope)) as Envelope;
    expect(roundtripped).toEqual(envelope);
  });
});

describe('openEnvelope', () => {
  it('AC3: correct passphrase yields a non-extractable CryptoKey', async () => {
    const { envelope } = await makeEnvelopeAndDek();
    const dek = await openEnvelope(envelope, PASSPHRASE);

    expect(dek.extractable).toBe(false);
    expect(dek.type).toBe('secret');
  });

  it('AC3: wrong passphrase throws WrongPassphraseError without leaking material', async () => {
    const { envelope } = await makeEnvelopeAndDek();

    let caught: unknown;
    try {
      await openEnvelope(envelope, 'wrong passphrase');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WrongPassphraseError);
    const message = (caught as Error).message;
    expect(message).not.toContain(PASSPHRASE);
    expect(message).not.toContain('wrong passphrase');
    expect(message.toLowerCase()).not.toMatch(/dek|kek|key/);
  });
});

describe('encryptJournal / decryptJournal', () => {
  it('AC4: same content encrypted twice yields different ciphertext/nonce but both decrypt to the same content', async () => {
    const { dek } = await makeEnvelopeAndDek();
    const content: JournalContent = { text: 'Heute war ein guter Tag.', mood: 'gut', tags: ['ruhe'] };

    const first = await encryptJournal(dek, content);
    const second = await encryptJournal(dek, content);

    expect(bytesToBase64(first.nonce)).not.toEqual(bytesToBase64(second.nonce));
    expect(bytesToBase64(first.ciphertext)).not.toEqual(bytesToBase64(second.ciphertext));

    await expect(decryptJournal(dek, first.ciphertext, first.nonce)).resolves.toEqual(content);
    await expect(decryptJournal(dek, second.ciphertext, second.nonce)).resolves.toEqual(content);
  });

  it('AC4: full roundtrip create -> open -> encrypt -> decrypt over text/mood/tags', async () => {
    const passphrase = 'a full roundtrip passphrase';
    const envelope = await createEnvelope(passphrase, FAST_KDF_PARAMS);
    const dek = await openEnvelope(envelope, passphrase);
    const content: JournalContent = {
      text: 'Voller Roundtrip.',
      mood: 'zufrieden',
      tags: ['test', 'roundtrip'],
    };

    const { ciphertext, nonce } = await encryptJournal(dek, content);
    const decrypted = await decryptJournal(dek, ciphertext, nonce);

    expect(decrypted).toEqual(content);
  });
});

describe('fester Testvektor (AC5/AC6)', () => {
  it('AC5: fixture envelope + known passphrase decrypts to the expected plaintext', async () => {
    const dek = await openEnvelope(fixture.envelope as Envelope, fixture.passphrase);
    const decrypted = await decryptJournal(
      dek,
      base64ToBytes(fixture.ciphertext),
      base64ToBytes(fixture.nonce),
    );

    expect(decrypted).toEqual(fixture.plaintext);
  });

  it('AC6: a flipped ciphertext byte throws JournalDecryptError instead of returning garbage', async () => {
    const dek = await openEnvelope(fixture.envelope as Envelope, fixture.passphrase);
    const tampered = base64ToBytes(fixture.ciphertext);
    tampered[0] ^= 0xff;

    await expect(decryptJournal(dek, tampered, base64ToBytes(fixture.nonce))).rejects.toBeInstanceOf(
      JournalDecryptError,
    );
  });
});

describe('AC7: kein Klartext/Schluesselmaterial im Log', () => {
  it('no console call leaks the passphrase or the plaintext across success and failure paths', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    ];

    const passphrase = 'ac7 secret passphrase';
    const content: JournalContent = { text: 'AC7 geheimer Klartext', mood: 'geheim', tags: ['ac7'] };

    const envelope = await createEnvelope(passphrase, FAST_KDF_PARAMS);
    const dek = await openEnvelope(envelope, passphrase);
    const { ciphertext, nonce } = await encryptJournal(dek, content);
    await decryptJournal(dek, ciphertext, nonce);

    // Fehlerpfade: falsche Passphrase, manipuliertes Chiffrat.
    await openEnvelope(envelope, 'wrong').catch(() => {});
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await decryptJournal(dek, tampered, nonce).catch(() => {});

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(passphrase);
        expect(serialized).not.toContain(content.text);
      }
      spy.mockRestore();
    }
  });

  it('static: the crypto modules never call console at all', () => {
    for (const file of ['envelope.ts', 'journal.ts', 'errors.ts', 'base64.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/console\./);
    }
  });
});
