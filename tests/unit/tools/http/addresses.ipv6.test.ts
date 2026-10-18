import { describe, it, expect } from 'vitest';
import { isPrivateAddress } from '../../../../src/tools/builtin/http/addresses.js';

/** The host as the request code sees it: `new URL()` normalises IPv6 literals. */
const hostOf = (raw: string): string => new URL(raw).hostname.replace(/^\[|\]$/g, '');

describe('isPrivateAddress — IPv6 carrying an IPv4 address', () => {
  // `new URL('http://[::ffff:169.254.169.254]/')` yields `::ffff:a9fe:a9fe`:
  // the check must see through the hexadecimal form, not only the dotted one.
  it.each([
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud metadata'],
    ['http://[0:0:0:0:0:ffff:a00:1]/', 'IPv4-mapped 10.0.0.1, expanded'],
    ['http://[::127.0.0.1]/', 'IPv4-compatible loopback'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 to cloud metadata'],
    ['http://[64:ff9b::10.0.0.1]/', 'NAT64 to a private address'],
    ['http://[2002:7f00:1::1]/', '6to4 wrapping loopback'],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'Teredo, which tunnels anywhere'],
    ['http://[fec0::1]/', 'site-local (deprecated)'],
    ['http://[0:0:0:0:0:0:0:1]/', 'loopback, expanded'],
  ])('refuses %s (%s)', (raw) => {
    expect(isPrivateAddress(hostOf(raw))).toBe(true);
  });

  it.each([
    ['::ffff:8.8.8.8'],
    ['::ffff:808:808'],
    ['64:ff9b::808:808'],
    ['2002:808:808::1'],
    ['2606:4700:4700::1111'],
    ['2a00:1450:4001:82a::200e'],
  ])('allows the public address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([['1::2::3'], ['1:2:3:4:5:6:7:8:9'], ['::ffff:300.1.1.1'], ['12345::'], ['gggg::1']])(
    'refuses the malformed literal %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );
});
