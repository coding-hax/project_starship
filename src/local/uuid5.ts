/**
 * Deterministic row id for `journal_entries` (ADR-0017): UUIDv5 over a fixed
 * namespace + `entryDate`. Same day -> same id on every device, so "one entry per
 * day" is a real key invariant instead of an app convention, and the existing
 * ADR-0008 conflict path (baseSeq/syncSeq) applies without a sync-engine special case.
 *
 * No `uuid` dependency (CLAUDE.md Regel 3) — SHA-1 is available via WebCrypto, and
 * UUIDv5 is only a few bit twiddles on top of it.
 */

/** Fixed, checked-in namespace — changing this would silently rename every entry id. */
const NAMESPACE = '9c9e5555-0634-4c30-9104-caae7c4acddd';

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function journalEntryId(entryDate: string): Promise<string> {
  const namespaceBytes = uuidToBytes(NAMESPACE);
  const nameBytes = new TextEncoder().encode(entryDate);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122

  return bytesToUuid(hash);
}
