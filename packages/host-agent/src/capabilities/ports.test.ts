import { describe, expect, it } from 'vitest';

import { compressIpv6, decodeAddress, isLoopbackBound } from './ports.js';

/**
 * The address field of `/proc/net/tcp` is hex in host byte order, which is
 * exactly the kind of format that looks plausible when it is wrong: a reversed
 * IPv4 address still renders as four dotted numbers, and a mis-grouped IPv6 one
 * still looks like an IPv6 address. Nothing downstream would catch it — the
 * Ports app would just offer to connect to the wrong host — so the conversion is
 * pinned to the values the kernel actually prints.
 */
describe('decoding /proc/net socket addresses', () => {
  it('reads a listening IPv4 address in host byte order', () => {
    // `0100007F` is 127.0.0.1: the bytes are stored least significant first.
    expect(decodeAddress('0100007F', 'ipv4')).toBe('127.0.0.1');
  });

  it('reads the IPv4 wildcard address', () => {
    expect(decodeAddress('00000000', 'ipv4')).toBe('0.0.0.0');
  });

  it('reads an IPv4 address on the local network', () => {
    // 192.168.1.10 → C0 A8 01 0A printed reversed.
    expect(decodeAddress('0A01A8C0', 'ipv4')).toBe('192.168.1.10');
  });

  it('reads the IPv6 loopback address', () => {
    // The kernel prints ::1 as sixteen bytes with the last group's bytes
    // reversed: 01 00 00 00 at the end of the line.
    expect(decodeAddress('00000000000000000000000001000000', 'ipv6')).toBe('::1');
  });

  it('reads the IPv6 wildcard address', () => {
    expect(decodeAddress('00000000000000000000000000000000', 'ipv6')).toBe('::');
  });

  it('reads an IPv4-mapped IPv6 address', () => {
    // ::ffff:127.0.0.1, which is how a dual-stack listener on loopback appears
    // in /proc/net/tcp6.
    expect(decodeAddress('0000000000000000FFFF00000100007F', 'ipv6')).toBe('::ffff:127.0.0.1');
  });

  it('leaves a malformed field alone rather than inventing an address', () => {
    expect(decodeAddress('1234', 'ipv4')).toBe('1234');
    expect(decodeAddress('abcd', 'ipv6')).toBe('abcd');
  });
});

describe('deciding whether a socket is loopback-only', () => {
  it('recognises an IPv4 loopback address', () => {
    expect(isLoopbackBound('127.0.0.1')).toBe(true);
  });

  it('recognises the IPv6 loopback address', () => {
    expect(isLoopbackBound('::1')).toBe(true);
  });

  it('recognises a dual-stack loopback address', () => {
    // The common shape for `vite` on Node 18+, and the reason this predicate
    // exists: it must not read as publicly reachable.
    expect(isLoopbackBound('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not call the wildcard address loopback', () => {
    expect(isLoopbackBound('0.0.0.0')).toBe(false);
    expect(isLoopbackBound('::')).toBe(false);
  });

  it('does not call a routable address loopback', () => {
    expect(isLoopbackBound('192.168.1.10')).toBe(false);
    expect(isLoopbackBound('2001:db8::1')).toBe(false);
  });
});

describe('compressing IPv6 groups', () => {
  it('joins groups with no run of zeros in full', () => {
    expect(compressIpv6(['2001', '0db8', '0001', '0002', '0003', '0004', '0005', '0006'])).toBe(
      '2001:db8:1:2:3:4:5:6'
    );
  });

  it('collapses the longest run of zero groups', () => {
    expect(compressIpv6(['2001', '0db8', '0', '0', '0', '0', '0', '1'])).toBe('2001:db8::1');
  });

  it('collapses a run at the start', () => {
    expect(compressIpv6(['0', '0', '0', '0', '0', '0', '0', '1'])).toBe('::1');
  });

  it('leaves a single zero group alone', () => {
    // `::` must stand for at least two groups; replacing one would produce an
    // address that means something different.
    expect(compressIpv6(['2001', '0db8', '0', '1', '1', '1', '1', '1'])).toBe(
      '2001:db8:0:1:1:1:1:1'
    );
  });
});
