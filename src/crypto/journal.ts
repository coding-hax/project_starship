import { JournalDecryptError } from './errors';
import {
  DEFAULT_KDF_PARAMS,
  openEnvelope,
  openEnvelopeExtractable,
  wrapDek,
  type Envelope,
  type KdfParams,
} from './envelope';

export * from './envelope';

export interface JournalContent {
  text: string;
  mood?: string;
  tags?: string[];
}

export interface EncryptedJournal {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
}

/**
 * 1-byte prefix on a v2 nonce (issue #480, F7) — never fed to GCM itself, only
 * used to tell a 13-byte v2 nonce (`[VERSION_MARKER, ...12-byte IV]`, bound to
 * an AAD) apart from a 12-byte v1 nonce (no AAD, pre-#480). The length itself
 * is the dispatch key in `decryptJournal`, not this byte's value.
 */
const VERSION_MARKER = 0x02;

/**
 * The AAD every v2 journal ciphertext is bound to (issue #480, F7): a row's
 * `id` and `entryDate`. Encrypt and decrypt share this one function so the two
 * sides can never derive the binding differently. `id` (UUIDv7) and
 * `entryDate` (`YYYY-MM-DD`) never contain `:`, so the separator is unambiguous.
 */
export function journalEntryAad(id: string, entryDate: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${id}:${entryDate}`);
}

/**
 * `aad` omitted keeps the pre-#480 v1 shape (12-byte nonce, no
 * `additionalData`) so every existing call site and stored ciphertext stays
 * valid. `aad` set produces a v2 ciphertext (13-byte nonce, `additionalData`
 * bound in) — the real write path (entry.ts) always passes it, so new entries
 * are always v2.
 */
export async function encryptJournal(
  dek: CryptoKey,
  content: JournalContent,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<EncryptedJournal> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(content));
  const algorithm: AesGcmParams = aad
    ? { name: 'AES-GCM', iv, additionalData: aad }
    : { name: 'AES-GCM', iv };
  const ciphertext = await crypto.subtle.encrypt(algorithm, dek, plaintext);
  const nonce = aad ? new Uint8Array([VERSION_MARKER, ...iv]) : iv;
  return { ciphertext: new Uint8Array(ciphertext), nonce };
}

/**
 * Dispatches on the nonce's decoded length, never on whether `aad` was passed
 * in — a v1 row (12 bytes) always takes the AAD-free branch, so there is no
 * path that could hand a v1 ciphertext to GCM with an AAD it was never
 * encrypted with (the "journal looks empty after update" risk). A v2 row
 * (13 bytes) is checked against `aad` regardless of whether the caller passed
 * one; a swapped ciphertext (foreign `id`/`entryDate`, so a mismatched `aad`)
 * fails the GCM tag exactly like any other tampering.
 */
export async function decryptJournal(
  dek: CryptoKey,
  ciphertext: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
  aad?: Uint8Array<ArrayBuffer>,
): Promise<JournalContent> {
  try {
    let algorithm: AesGcmParams;
    if (nonce.length === 13) {
      if (nonce[0] !== VERSION_MARKER) throw new JournalDecryptError();
      algorithm = { name: 'AES-GCM', iv: nonce.slice(1), additionalData: aad };
    } else if (nonce.length === 12) {
      algorithm = { name: 'AES-GCM', iv: nonce };
    } else {
      throw new JournalDecryptError();
    }
    const plaintext = await crypto.subtle.decrypt(algorithm, dek, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as JournalContent;
  } catch {
    throw new JournalDecryptError();
  }
}

/* --------------------------------- recovery (S6, issue #343) --------------------------------- */

const RECOVERY_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32, no padding

/**
 * 256 bits of entropy (`crypto.getRandomValues`), formatted as grouped base32
 * (ADR-0015 point 2) so it reads and copies cleanly — 13 groups of 4 characters.
 * Fed straight into `deriveKek` as secret text, same as a passphrase: there is no
 * need to decode it back to raw bytes, the KDF treats any string as key material.
 * A separate secret from the auth recovery code (ADR-0015 point 5) — never reuse it.
 */
export function generateRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bits = 0;
  let value = 0;
  let raw = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      raw += RECOVERY_KEY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    raw += RECOVERY_KEY_ALPHABET[(value << (5 - bits)) & 31];
  }
  return raw.match(/.{1,4}/g)!.join('-');
}

/** Strips whitespace/dashes and uppercases, so pasted or retyped input still matches. */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export interface EnvelopesWithRecovery {
  passphraseEnvelope: Envelope;
  recoveryEnvelope: Envelope;
  recoveryKey: string;
  dek: CryptoKey;
}

/**
 * Creates both KEK wraps for a fresh DEK in one step (AC1). `wrapDek` needs an
 * extractable source key, but the DEK must end up non-extractable (ADR-0016) —
 * so the extractable handle is generated here, wrapped under both KEKs, and then
 * discarded; `dek` on the returned value is the non-extractable copy reopened via
 * the passphrase envelope for the running session.
 */
export async function createEnvelopesWithRecovery(
  passphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<EnvelopesWithRecovery> {
  const recoveryKey = generateRecoveryKey();
  const extractableDek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const [passphraseEnvelope, recoveryEnvelope] = await Promise.all([
    wrapDek(extractableDek, passphrase, kdfParamsOverride),
    wrapDek(extractableDek, normalizeRecoveryKey(recoveryKey), kdfParamsOverride),
  ]);
  const dek = await openEnvelope(passphraseEnvelope, passphrase);
  return { passphraseEnvelope, recoveryEnvelope, recoveryKey, dek };
}

/**
 * Opens the recovery envelope (AC3). Delegates to `openEnvelope`, so a wrong
 * recovery key throws the exact same `WrongPassphraseError` as a wrong passphrase
 * (AC5) — the UI cannot tell, and must not, which secret was wrong.
 */
export async function openEnvelopeWithRecovery(
  envelope: Envelope,
  recoveryKey: string,
): Promise<CryptoKey> {
  return openEnvelope(envelope, normalizeRecoveryKey(recoveryKey));
}

/**
 * Re-wraps the existing DEK under a new passphrase-KEK (AC4) — entries stay
 * encrypted under the same DEK, only the passphrase envelope changes. Recovering
 * an extractable DEK is only safe here because whoever holds the recovery key
 * already has full DEK access regardless (same threat model as ADR-0016); the
 * extractable handle lives only inside this function and is never returned.
 */
export async function rewrapPassphrase(
  recoveryEnvelope: Envelope,
  recoveryKey: string,
  newPassphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<Envelope> {
  const extractableDek = await openEnvelopeExtractable(
    recoveryEnvelope,
    normalizeRecoveryKey(recoveryKey),
  );
  return wrapDek(extractableDek, newPassphrase, kdfParamsOverride);
}

export interface ReissuedRecovery {
  recoveryEnvelope: Envelope;
  recoveryKey: string;
}

/**
 * Issues a fresh recovery key for an already-set-up journal (issue #391): the
 * original key can never be shown again (only its KEK-wrapped DEK is stored), so
 * this generates a new one and re-wraps the *same* DEK under it — the old
 * recovery envelope is overwritten and its key becomes invalid, entries stay
 * readable under the unchanged DEK. Requires the passphrase (the only remaining
 * proof of knowledge once the old recovery key is lost) to obtain an extractable
 * DEK; a wrong passphrase throws `WrongPassphraseError` before anything is wrapped.
 */
export async function reissueRecovery(
  passphraseEnvelope: Envelope,
  passphrase: string,
  kdfParamsOverride: Omit<KdfParams, 'salt'> = DEFAULT_KDF_PARAMS,
): Promise<ReissuedRecovery> {
  const extractableDek = await openEnvelopeExtractable(passphraseEnvelope, passphrase);
  const recoveryKey = generateRecoveryKey();
  const recoveryEnvelope = await wrapDek(
    extractableDek,
    normalizeRecoveryKey(recoveryKey),
    kdfParamsOverride,
  );
  return { recoveryEnvelope, recoveryKey };
}
