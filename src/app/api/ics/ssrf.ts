/**
 * SSRF guard rails for the `.ics` proxy (issue #560, ADR-0022) — pure, no
 * DNS/network calls itself, so it's Vitest-testable without mocking either.
 * `route.ts` is the only caller: it resolves the host, then asks
 * `isBlockedAddress` about every returned address before ever connecting.
 */

/** Only `https` is allowed — no `http`, no `file:`, no anything else. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Ungültige URL.');
  }
  if (url.protocol !== 'https:') {
    throw new SsrfBlockedError('Nur https:// ist erlaubt.');
  }
  return url;
}

export class SsrfBlockedError extends Error {}

/** Parses a dotted-quad IPv4 address into its four octets, or `null` if `value` isn't one. */
function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

/** `octets` falls inside the first `prefixLength` bits of `base`. */
function ipv4InRange(
  octets: [number, number, number, number],
  base: [number, number, number, number],
  prefixLength: number,
): boolean {
  const value = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
  const baseValue = (base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3];
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

const IPV4_BLOCKED_RANGES: { base: [number, number, number, number]; prefixLength: number }[] = [
  { base: [0, 0, 0, 0], prefixLength: 8 }, // "this network"
  { base: [10, 0, 0, 0], prefixLength: 8 }, // private
  { base: [127, 0, 0, 0], prefixLength: 8 }, // loopback
  { base: [169, 254, 0, 0], prefixLength: 16 }, // link-local, incl. cloud metadata 169.254.169.254
  { base: [172, 16, 0, 0], prefixLength: 12 }, // private
  { base: [192, 168, 0, 0], prefixLength: 16 }, // private
];

/** Lowercased, zero-padded-agnostic prefix match against an already-normalized IPv6 address. */
function ipv6HasPrefix(address: string, prefix: string): boolean {
  return address.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Is `address` a loopback/private/link-local/metadata address (IPv4 or IPv6)?
 * Covers the ranges ADR-0022 lists: 0/8, 10/8, 127/8, 169.254/16 (incl.
 * cloud metadata 169.254.169.254), 172.16/12, 192.168/16, `::1`, `fc00::/7`
 * (unique local), `fe80::/10` (link-local) — plus IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`), which would otherwise sail straight past the IPv4 checks.
 */
export function isBlockedAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4Candidate = mapped ? mapped[1] : address;
  const ipv4 = parseIpv4(ipv4Candidate);
  if (ipv4) {
    return IPV4_BLOCKED_RANGES.some((range) => ipv4InRange(ipv4, range.base, range.prefixLength));
  }

  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  // fc00::/7 splits across the second hex digit's top bit: "fc.." or "fd..".
  if (ipv6HasPrefix(normalized, 'fc') || ipv6HasPrefix(normalized, 'fd')) return true;
  if (ipv6HasPrefix(normalized, 'fe80:')) return true;

  return false;
}
