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
 * IPv4-mapped and 6to4 IPv6 addresses are unwrapped before checking, because
 * `::ffff:127.0.0.1` reaches loopback just as well as `127.0.0.1` does.
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
  const lower = address.toLowerCase().split('%')[0] ?? '';

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible forms reach the v4
  // address they wrap, so they are judged as that address.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return isPrivateIPv4(mapped[1]);

  if (lower === '::' || lower === '::1') return true; // unspecified, loopback

  const head = lower.split(':')[0] ?? '';
  const prefix = parseInt(head.padEnd(4, '0'), 16);
  if (Number.isNaN(prefix)) return true;

  if ((prefix & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((prefix & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((prefix & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // 2002::/16 (6to4) embeds an IPv4 address in the next two groups.
  if (prefix === 0x2002) {
    const groups = lower.split(':');
    const first = parseInt(groups[1] ?? '0', 16);
    const second = parseInt(groups[2] ?? '0', 16);
    if (!Number.isNaN(first) && !Number.isNaN(second)) {
      const v4 = [first >> 8, first & 0xff, second >> 8, second & 0xff].join('.');
      return isPrivateIPv4(v4);
    }
  }

  return false;
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
