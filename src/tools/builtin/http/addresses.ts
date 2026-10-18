import { isIP } from 'node:net';

/**
 * Whether `address` belongs to a range that must never be reachable from a
 * model-influenced request.
 *
 * Covers loopback, private and link-local space in both families. The entry
 * that matters most in practice is `169.254.169.254`: the cloud metadata
 * endpoint, and the single most valuable target of a server-side request
 * forgery, since it hands out instance credentials to anyone who asks.
 *
 * IPv6 addresses that carry an IPv4 address (IPv4-mapped and -compatible,
 * 6to4, NAT64 `64:ff9b::/96`) are judged as that address, because
 * `::ffff:127.0.0.1` reaches loopback just as well as `127.0.0.1` does;
 * Teredo (`2001::/32`), which tunnels to any IPv4 address, is refused.
 *
 * @param address - A literal IP address (not a hostname).
 * @returns `true` when the address must be refused.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  // Not an IP at all: refuse rather than guess.
  return true;
}

/** Whether an IPv4 literal is in reserved, private or link-local space. */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Whether an IPv6 literal is in reserved, private or link-local space. */
function isPrivateIPv6(address: string): boolean {
  // Judged on the 16 bytes, never on the text: `new URL()` rewrites
  // `::ffff:127.0.0.1` as `::ffff:7f00:1`, and a check on the dotted form
  // alone would wave the hexadecimal one through.
  const bytes = ipv6Bytes(address);
  if (bytes === null) return true;
  const v4At = (offset: number): string => bytes.slice(offset, offset + 4).join('.');

  const zeroPrefix = bytes.slice(0, 10).every((byte) => byte === 0);
  if (zeroPrefix && bytes[10] === 0 && bytes[11] === 0) {
    // ::, ::1 and IPv4-compatible ::a.b.c.d
    if (bytes.slice(12).every((byte) => byte === 0)) return true;
    if (bytes.slice(12, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
    return isPrivateIPv4(v4At(12));
  }
  // IPv4-mapped ::ffff:a.b.c.d reaches the IPv4 address it wraps.
  if (zeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff) return isPrivateIPv4(v4At(12));

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (first === 0xff) return true; // ff00::/8 multicast

  // 2002::/16 (6to4) embeds an IPv4 address in bytes 2-5.
  if (first === 0x20 && second === 0x02) return isPrivateIPv4(v4At(2));
  // 64:ff9b::/96 (NAT64) translates to the IPv4 address in the last 4 bytes.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPrivateIPv4(v4At(12));
  }
  // 2001::/32 (Teredo) tunnels to an arbitrary IPv4 address: refuse it.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true;

  return false;
}

/**
 * The 16 bytes of an IPv6 literal (zone id dropped, `::` expanded, a
 * trailing dotted IPv4 accepted), or `null` when it is not one.
 */
function ipv6Bytes(address: string): number[] | null {
  let text = (address.toLowerCase().split('%')[0] ?? '').replace(/^\[|\]$/g, '');
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((part) => part > 255)) return null;
    const hex = (high: number, low: number): string => ((high << 8) | low).toString(16);
    text =
      text.slice(0, dotted.index) +
      hex(parts[0] ?? 0, parts[1] ?? 0) +
      ':' +
      hex(parts[2] ?? 0, parts[3] ?? 0);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/**
 * Whether `host` is covered by an allowlist entry.
 *
 * An entry may be an exact host (`api.example.com`) or a subdomain wildcard
 * (`*.example.com`), which matches subdomains but not the bare domain.
 *
 * @param host    - Hostname from the URL, without port.
 * @param allowed - Allowlist entries. An empty list allows everything.
 */
export function hostAllowed(host: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const target = host.toLowerCase().replace(/\.$/, '');

  return allowed.some((entry) => {
    const pattern = entry.toLowerCase().replace(/\.$/, '');
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.example.com'
      return target.endsWith(suffix);
    }
    return target === pattern;
  });
}
