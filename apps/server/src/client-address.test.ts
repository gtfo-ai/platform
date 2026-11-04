import { describe, expect, it } from 'vitest';
import {
  compileTrust,
  isTrustProxyEntry,
  normaliseAddress,
  resolveClientAddress,
} from './client-address.js';

describe('isTrustProxyEntry', () => {
  it('admits addresses and CIDR ranges of both families', () => {
    for (const entry of ['127.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '::1', '2400:cb00::/32', '::/0']) {
      expect(isTrustProxyEntry(entry), entry).toBe(true);
    }
  });

  it('refuses a bare integer (a hop count), a host name, a bad prefix and a double slash', () => {
    for (const entry of [
      '2',
      '1',
      'proxy.internal',
      '10.0.0.0/33',
      '::1/129',
      '10.0.0.0/x',
      '10.0.0.0/8/1',
      '',
    ]) {
      expect(isTrustProxyEntry(entry), entry).toBe(false);
    }
  });
});

describe('compileTrust', () => {
  it('trusts nothing for false and everything for true', () => {
    expect(compileTrust(false)('10.0.0.1')).toBe(false);
    expect(compileTrust(true)('198.51.100.1')).toBe(true);
  });

  it('trusts exactly the listed addresses and ranges, an IPv4-mapped peer included', () => {
    const trusted = compileTrust(['10.0.0.1', '203.0.113.0/24', '2400:cb00::/32']);
    expect(trusted('10.0.0.1')).toBe(true);
    expect(trusted('10.0.0.2')).toBe(false);
    expect(trusted('203.0.113.255')).toBe(true);
    expect(trusted('203.0.114.0')).toBe(false);
    expect(trusted('::ffff:203.0.113.9')).toBe(true);
    expect(trusted('2400:cb00::1')).toBe(true);
    expect(trusted('2400:cb01::1')).toBe(false);
    expect(trusted('not-an-address')).toBe(false);
  });
});

describe('resolveClientAddress', () => {
  const base = {
    socketAddress: '198.51.100.9',
    requestIp: '198.51.100.9',
    headers: { 'cf-connecting-ip': '192.0.2.1' },
    trusted: compileTrust(['203.0.113.0/24']),
    trustedHeader: 'cf-connecting-ip',
  };

  it('ignores the header from an untrusted peer and keys on the socket address', () => {
    expect(resolveClientAddress(base)).toBe('198.51.100.9');
  });

  it('believes the header from a trusted peer', () => {
    expect(
      resolveClientAddress({ ...base, socketAddress: '203.0.113.5', requestIp: '203.0.113.5' }),
    ).toBe('192.0.2.1');
  });

  it('falls back to request.ip when the trusted header is absent, not an address, or not configured', () => {
    const trustedPeer = { ...base, socketAddress: '203.0.113.5', requestIp: '192.0.2.77' };
    expect(resolveClientAddress({ ...trustedPeer, headers: {} })).toBe('192.0.2.77');
    expect(resolveClientAddress({ ...trustedPeer, headers: { 'cf-connecting-ip': 'evil' } })).toBe(
      '192.0.2.77',
    );
    expect(resolveClientAddress({ ...trustedPeer, trustedHeader: null })).toBe('192.0.2.77');
    expect(
      resolveClientAddress({ ...trustedPeer, headers: { 'cf-connecting-ip': ['192.0.2.3', 'x'] } }),
    ).toBe('192.0.2.3');
  });

  it('keys an IPv4-mapped address as its IPv4 address', () => {
    expect(normaliseAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normaliseAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(
      resolveClientAddress({ ...base, socketAddress: undefined, requestIp: '::ffff:198.51.100.9' }),
    ).toBe('198.51.100.9');
  });
});
