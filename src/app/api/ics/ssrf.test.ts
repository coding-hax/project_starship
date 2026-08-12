import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, isBlockedAddress, SsrfBlockedError } from './ssrf';

describe('assertPublicHttpsUrl', () => {
  it('accepts a well-formed https URL', () => {
    const url = assertPublicHttpsUrl('https://example.com/feiertage.ics');
    expect(url.hostname).toBe('example.com');
  });

  it('rejects http', () => {
    expect(() => assertPublicHttpsUrl('http://example.com/feiertage.ics')).toThrow(SsrfBlockedError);
  });

  it('rejects file://', () => {
    expect(() => assertPublicHttpsUrl('file:///etc/passwd')).toThrow(SsrfBlockedError);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertPublicHttpsUrl('not a url')).toThrow(SsrfBlockedError);
  });
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback range'],
    ['10.0.0.1', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12 upper bound'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.0.1', 'link-local'],
    ['0.0.0.0', '"this network"'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'unique local fc00::/7'],
    ['fd12:3456::1', 'unique local fd../7'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped cloud metadata'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['93.184.216.34', 'public IPv4 (example.com)'],
    ['172.32.0.1', 'just outside 172.16/12'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'public IPv6 (example.com)'],
  ])('allows %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});
