import { describe, it, expect } from 'vitest';
import { hostAllowed, isPrivateAddress } from '../../../../src/tools/builtin/http/addresses.js';

describe('isPrivateAddress — IPv4', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private class A'],
    ['172.16.0.1', 'private class B, low edge'],
    ['172.31.255.255', 'private class B, high edge'],
    ['192.168.1.1', 'private class C'],
    ['0.0.0.0', 'this network'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  // The single most valuable SSRF target: it hands out instance credentials to
  // whoever asks.
  it('refuses the cloud metadata endpoint', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['192.169.0.1'], ['100.63.255.255']])(
    'allows the public address %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('refuses a malformed address rather than guessing', () => {
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('isPrivateAddress — IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link local'],
    ['ff02::1', 'multicast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  // `::ffff:127.0.0.1` reaches loopback exactly as `127.0.0.1` does, so it has
  // to be judged as the address it wraps.
  it('unwraps IPv4-mapped addresses before deciding', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps 6to4 addresses before deciding', () => {
    expect(isPrivateAddress('2002:7f00:0001::')).toBe(true); // 127.0.0.1
    expect(isPrivateAddress('2002:0808:0808::')).toBe(false); // 8.8.8.8
  });

  it('allows a public address', () => {
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('ignores a zone suffix', () => {
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
  });
});

describe('hostAllowed', () => {
  it('allows everything when the list is empty', () => {
    expect(hostAllowed('anything.example', [])).toBe(true);
  });

  it('matches an exact host', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('other.example.com', ['api.example.com'])).toBe(false);
  });

  it('matches subdomains under a wildcard', () => {
    expect(hostAllowed('docs.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
  });

  // Otherwise `*.example.com` would also cover `evilexample.com`.
  it('does not let a wildcard match a lookalike domain', () => {
    expect(hostAllowed('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.attacker.net', ['*.example.com'])).toBe(false);
  });

  it('ignores case and a trailing dot', () => {
    expect(hostAllowed('API.Example.com.', ['api.example.com'])).toBe(true);
  });
});
