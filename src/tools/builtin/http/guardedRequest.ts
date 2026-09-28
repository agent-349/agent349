import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { EgressDeniedError } from '../../../errors/index.js';
import { hostAllowed, isPrivateAddress } from './addresses.js';

/** One outbound request, with the guards that apply to it. */
export interface GuardedRequestOptions {
  /** Absolute URL. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body, already serialised. */
  body?: string;
  /** Wall-clock cap for the whole exchange, in milliseconds. */
  timeoutMs: number;
  /** Response bytes to read before cutting the stream off. */
  maxBytes: number;
  /** Hosts that may be contacted. Empty means any host passing the IP checks. */
  allowedHosts?: string[];
  /**
   * Resolve DNS and refuse private, loopback and link-local destinations,
   * pinning the connection to the address that was checked.
   *
   * Off for a fixed, integrator-declared endpoint (which may legitimately be an
   * internal service); on whenever the destination is influenced by the model.
   */
  blockPrivateAddresses: boolean;
  /** Follow 3xx responses. Off by default at every call site. */
  followRedirects?: boolean;
  /** Redirect hops allowed when following. */
  maxRedirects?: number;
}

/** What an outbound request returned. */
export interface GuardedResponse {
  status: number;
  headers: Record<string, string>;
  /** Body decoded as text, cut at `maxBytes`. */
  body: string;
  /** `true` when the body was cut short. */
  truncated: boolean;
  /** URL that actually served the response, after any redirects. */
  finalUrl: string;
}

/** Resolves a hostname to every address it answers with. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

/**
 * Seams the transport is built from, injectable so the guard chain — DNS
 * checks included — is testable without a socket or a live nameserver.
 */
export interface HttpTransportDeps {
  /** Performs the exchange. Defaults to Node's http/https. */
  performer?: RequestPerformer;
  /** Resolves hostnames. Defaults to the system resolver. */
  resolve?: AddressResolver;
}

/** Injection seam for tests, so no test needs a live socket. */
export type RequestPerformer = (
  url: URL,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    timeoutMs: number;
    maxBytes: number;
    pinnedAddress: string | null;
  },
) => Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>;

/**
 * Performs an outbound HTTP request under egress control.
 *
 * ### The chain
 * 1. **Scheme** — `http` and `https` only. `file:`, `data:` and the rest are
 *    refused outright.
 * 2. **Host allowlist** — when one is configured.
 * 3. **Address check** — every address the hostname resolves to is inspected,
 *    not just the first: a name that answers with one public and one private
 *    address must not squeak through.
 * 4. **Pinning** — the connection is made to the address that was checked, via
 *    a custom `lookup`. This is what closes the DNS-rebinding window, where a
 *    name resolves publicly for the check and privately a moment later for the
 *    connection. It is the step most implementations skip, and skipping it
 *    makes the other four decorative.
 * 5. **Per-hop revalidation** — a redirect is a brand new destination and gets
 *    the whole chain again.
 * 6. **Streaming cap** — the body is cut while it arrives, so an enormous
 *    response is never fully downloaded.
 *
 * @param options   - The request and its guards.
 * @param performer - Transport, injected in tests. Defaults to Node's own.
 * @returns The response, with the body already capped.
 * @throws {@link EgressDeniedError} when a guard refuses the destination.
 */
export async function guardedRequest(
  options: GuardedRequestOptions,
  deps: HttpTransportDeps = {},
): Promise<GuardedResponse> {
  const performer = deps.performer ?? nodeRequest;
  const resolve = deps.resolve ?? systemResolve;
  const maxRedirects = options.followRedirects === true ? (options.maxRedirects ?? 3) : 0;
  let current = options.url;
  let body = options.body;
  let method = options.method;

  for (let hop = 0; ; hop += 1) {
    const url = parseUrl(current);
    await assertReachable(url, options, resolve);

    const pinnedAddress = options.blockPrivateAddresses ? await pinAddress(url, resolve) : null;

    const response = await performer(url, {
      method,
      headers: options.headers ?? {},
      body,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      pinnedAddress,
    });

    const location = response.headers['location'];
    const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;

    if (!isRedirect || hop >= maxRedirects) {
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        truncated: response.truncated,
        finalUrl: url.toString(),
      };
    }

    current = new URL(location, url).toString();
    // A redirected request carries no body, and 303 (plus the de-facto
    // behaviour of 301/302) turns it into a GET.
    body = undefined;
    if (response.status === 303 || method !== 'GET') method = 'GET';
  }
}

/** Parses `raw`, refusing anything that is not a usable absolute URL. */
function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressDeniedError(raw, 'malformed-url', `'${raw}' is not a valid absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressDeniedError(
      raw,
      'scheme',
      `Only http and https are allowed; '${url.protocol}' is not.`,
    );
  }
  return url;
}

/** Applies the allowlist and, when enabled, the address checks. */
async function assertReachable(
  url: URL,
  options: GuardedRequestOptions,
  resolve: AddressResolver,
): Promise<void> {
  const allowed = options.allowedHosts ?? [];
  if (!hostAllowed(url.hostname, allowed)) {
    throw new EgressDeniedError(
      url.hostname,
      'allowed-hosts',
      `Host '${url.hostname}' is not in the allowed list: ${allowed.join(', ')}.`,
    );
  }

  if (!options.blockPrivateAddresses) return;

  for (const address of await resolveAll(url.hostname, resolve)) {
    if (isPrivateAddress(address)) {
      throw new EgressDeniedError(
        url.hostname,
        'private-address',
        `Host '${url.hostname}' resolves to ${address}, which is a private, loopback or ` +
          'link-local address and cannot be reached.',
      );
    }
  }
}

/** The system resolver, used when no other is injected. */
const systemResolve: AddressResolver = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true });
  if (entries.length === 0) throw new Error('no addresses');
  return entries.map((entry) => entry.address);
};

/** Every address a hostname resolves to, or the literal when it is one. */
async function resolveAll(hostname: string, resolve: AddressResolver): Promise<string[]> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isLiteralAddress(literal)) return [literal];

  try {
    const addresses = await resolve(hostname);
    if (addresses.length === 0) throw new Error('no addresses');
    return addresses;
  } catch (err) {
    throw new EgressDeniedError(hostname, 'dns', `Could not resolve '${hostname}'.`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/** Whether `value` is already an IP literal rather than a name. */
function isLiteralAddress(value: string): boolean {
  return /^[\d.]+$/.test(value) || value.includes(':');
}

/** Picks the address to pin the connection to, after it has been checked. */
async function pinAddress(url: URL, resolve: AddressResolver): Promise<string> {
  const addresses = await resolveAll(url.hostname, resolve);
  const first = addresses[0];
  if (first === undefined) {
    throw new EgressDeniedError(url.hostname, 'dns', `Could not resolve '${url.hostname}'.`);
  }
  return first;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DNS `lookup` hook that answers with the address the guards already checked.
 *
 * Node calls the hook with `{ all: true }` whenever happy-eyeballs address
 * selection is on — the default since Node 20 — and then expects an array of
 * `{ address, family }`; with `all` unset it expects `(address, family)`
 * positionally. Answering in the wrong shape makes Node refuse the connection
 * with `Invalid IP address: undefined`, which is how pinning broke every real
 * request on Node >= 20 while the tests, which inject their own transport,
 * stayed green. Both shapes are answered here.
 *
 * @param address - Checked address the connection must go to.
 */
export function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;

  const hook = (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };

  // Node's own typing covers only the `all: true` shape; the hook answers both.
  return hook as unknown as LookupFunction;
}

/**
 * Default transport, on `node:http` / `node:https`.
 *
 * Uses the request's `lookup` hook rather than swapping the hostname for an IP,
 * so the connection goes to the checked address while the `Host` header and TLS
 * SNI keep the original name — pinning without breaking virtual hosting or
 * certificate validation.
 */
const nodeRequest: RequestPerformer = (url, init) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = send(
      url,
      {
        method: init.method,
        headers: init.headers,
        timeout: init.timeoutMs,
        ...(init.pinnedAddress !== null && { lookup: pinnedLookup(init.pinnedAddress) }),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > init.maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - init.maxBytes)));
            truncated = true;
            // Stop pulling: an oversized response should never be fully read.
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const finish = (): void => {
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        };

        res.on('end', finish);
        res.on('close', finish);
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${init.timeoutMs} ms`));
    });
    req.on('error', reject);

    if (init.body !== undefined) req.write(init.body);
    req.end();
  });

/** Collapses Node's header bag into plain lower-cased strings. */
function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
