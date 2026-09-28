import { describe, it, expect, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardedRequest, pinnedLookup } from '../../../../src/tools/builtin/http/guardedRequest.js';
import type { RequestPerformer } from '../../../../src/tools/builtin/http/guardedRequest.js';
import { EgressDeniedError } from '../../../../src/errors/index.js';

/** A transport that records what it was asked to do and replays canned answers. */
function performer(
  responses: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    truncated?: boolean;
  }[] = [{}],
): RequestPerformer & { calls: { url: string; pinned: string | null; method: string }[] } {
  const calls: { url: string; pinned: string | null; method: string }[] = [];
  let index = 0;

  const fn = async (
    url: URL,
    init: { method: string; pinnedAddress: string | null },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
  }> => {
    calls.push({ url: url.toString(), pinned: init.pinnedAddress, method: init.method });
    const canned = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return {
      status: canned.status ?? 200,
      headers: canned.headers ?? {},
      body: canned.body ?? 'ok',
      truncated: canned.truncated ?? false,
    };
  };

  return Object.assign(fn, { calls });
}

const BASE = {
  method: 'GET',
  timeoutMs: 1000,
  maxBytes: 1000,
  blockPrivateAddresses: false,
};

/** Stub resolver, so the guard chain is exercised without a nameserver. */

const resolve = async (hostname: string): Promise<string[]> =>
  hostname === 'evil.com' ? ['198.51.100.9'] : ['93.184.216.34'];

/** Wraps a transport into the deps object `guardedRequest` takes. */
function deps(transport: RequestPerformer): {
  performer: RequestPerformer;
  resolve: typeof resolve;
} {
  return { performer: transport, resolve };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheme and shape
// ─────────────────────────────────────────────────────────────────────────────

describe('guardedRequest scheme guard', () => {
  it.each([
    ['file:///etc/passwd'],
    ['data:text/html,hello'],
    ['ftp://example.com/x'],
    ['gopher://example.com'],
  ])('refuses %s', async (url) => {
    await expect(guardedRequest({ ...BASE, url }, deps(performer()))).rejects.toThrow(
      EgressDeniedError,
    );
  });

  it('refuses a malformed URL', async () => {
    await expect(guardedRequest({ ...BASE, url: 'not a url' }, deps(performer()))).rejects.toThrow(
      /not a valid absolute URL/,
    );
  });

  it('allows http and https', async () => {
    await expect(
      guardedRequest({ ...BASE, url: 'https://example.com/x' }, deps(performer())),
    ).resolves.toMatchObject({ status: 200 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Host allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe('guardedRequest host allowlist', () => {
  it('refuses a host outside the list', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'https://evil.com/x', allowedHosts: ['api.example.com'] },
        deps(performer()),
      ),
    ).rejects.toThrow(/not in the allowed list/);
  });

  it('allows a host on the list', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'https://api.example.com/x', allowedHosts: ['api.example.com'] },
        deps(performer()),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Address checks and pinning
// ─────────────────────────────────────────────────────────────────────────────

describe('guardedRequest address guard', () => {
  it('refuses a literal loopback address', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'http://127.0.0.1:8080/x', blockPrivateAddresses: true },
        deps(performer()),
      ),
    ).rejects.toThrow(/private, loopback or link-local/);
  });

  it('refuses the cloud metadata endpoint by literal address', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'http://169.254.169.254/latest/meta-data/', blockPrivateAddresses: true },
        deps(performer()),
      ),
    ).rejects.toThrow(EgressDeniedError);
  });

  it('refuses a literal IPv6 loopback', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'http://[::1]/x', blockPrivateAddresses: true },
        deps(performer()),
      ),
    ).rejects.toThrow(EgressDeniedError);
  });

  it('skips the address checks when they are switched off', async () => {
    await expect(
      guardedRequest(
        { ...BASE, url: 'http://127.0.0.1:8080/x', blockPrivateAddresses: false },
        deps(performer()),
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  // Pinning is what closes the DNS-rebinding window: without it, a name can
  // resolve publicly for the check and privately for the connection.
  it('pins the connection to the address it checked', async () => {
    const transport = performer();
    await guardedRequest(
      { ...BASE, url: 'http://93.184.216.34/x', blockPrivateAddresses: true },
      deps(transport),
    );

    expect(transport.calls[0]?.pinned).toBe('93.184.216.34');
  });

  it('passes no pinned address when the checks are off', async () => {
    const transport = performer();
    await guardedRequest({ ...BASE, url: 'https://example.com/x' }, deps(transport));

    expect(transport.calls[0]?.pinned).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Redirects
// ─────────────────────────────────────────────────────────────────────────────

describe('guardedRequest redirects', () => {
  it('does not follow redirects by default', async () => {
    const transport = performer([
      { status: 302, headers: { location: 'https://elsewhere.com/x' } },
    ]);
    const response = await guardedRequest(
      { ...BASE, url: 'https://example.com/x' },
      deps(transport),
    );

    expect(response.status).toBe(302);
    expect(transport.calls).toHaveLength(1);
  });

  it('follows a redirect when asked to', async () => {
    const transport = performer([
      { status: 302, headers: { location: 'https://example.com/final' } },
      { status: 200, body: 'landed' },
    ]);
    const response = await guardedRequest(
      { ...BASE, url: 'https://example.com/x', followRedirects: true },
      deps(transport),
    );

    expect(response.body).toBe('landed');
    expect(response.finalUrl).toBe('https://example.com/final');
  });

  // The classic way around an egress allowlist: pass the check, then bounce.
  it('revalidates the allowlist on every hop', async () => {
    const transport = performer([{ status: 302, headers: { location: 'https://evil.com/x' } }]);

    await expect(
      guardedRequest(
        {
          ...BASE,
          url: 'https://api.example.com/x',
          allowedHosts: ['api.example.com'],
          followRedirects: true,
        },
        deps(transport),
      ),
    ).rejects.toThrow(/not in the allowed list/);
  });

  it('revalidates the address checks on every hop', async () => {
    const transport = performer([{ status: 302, headers: { location: 'http://127.0.0.1/x' } }]);

    await expect(
      guardedRequest(
        {
          ...BASE,
          url: 'http://93.184.216.34/x',
          blockPrivateAddresses: true,
          followRedirects: true,
        },
        deps(transport),
      ),
    ).rejects.toThrow(/private, loopback or link-local/);
  });

  it('stops after the configured number of hops', async () => {
    const transport = performer([
      { status: 302, headers: { location: 'https://example.com/next' } },
    ]);
    const response = await guardedRequest(
      { ...BASE, url: 'https://example.com/x', followRedirects: true, maxRedirects: 2 },
      deps(transport),
    );

    expect(response.status).toBe(302);
    expect(transport.calls).toHaveLength(3); // original + 2 hops
  });

  it('turns a redirected POST into a GET and drops the body', async () => {
    const transport = performer([
      { status: 303, headers: { location: 'https://example.com/done' } },
      { status: 200 },
    ]);
    await guardedRequest(
      {
        ...BASE,
        url: 'https://example.com/x',
        method: 'POST',
        body: 'payload',
        followRedirects: true,
      },
      deps(transport),
    );

    expect(transport.calls[1]?.method).toBe('GET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response handling
// ─────────────────────────────────────────────────────────────────────────────

describe('guardedRequest response', () => {
  it('reports truncation from the transport', async () => {
    const response = await guardedRequest(
      { ...BASE, url: 'https://example.com/x' },
      deps(performer([{ truncated: true }])),
    );

    expect(response.truncated).toBe(true);
  });

  it('passes the headers and body through', async () => {
    const response = await guardedRequest(
      { ...BASE, url: 'https://example.com/x' },
      deps(performer([{ headers: { 'content-type': 'text/html' }, body: '<p>hi</p>' }])),
    );

    expect(response.headers['content-type']).toBe('text/html');
    expect(response.body).toBe('<p>hi</p>');
  });

  it('hands the transport the configured caps', async () => {
    const seen = vi.fn();

    const transport: RequestPerformer = async (_url, init) => {
      seen(init.timeoutMs, init.maxBytes);
      return { status: 200, headers: {}, body: '', truncated: false };
    };

    await guardedRequest(
      { ...BASE, url: 'https://example.com/x', timeoutMs: 4321, maxBytes: 999 },
      deps(transport),
    );

    expect(seen).toHaveBeenCalledWith(4321, 999);
  });
});

/**
 * Pinning runs inside Node's own transport, which every other test here
 * replaces with an injected performer. That is exactly where it broke: Node 20
 * asks the hook for every address (`all: true`) and refuses the connection with
 * `Invalid IP address: undefined` when it gets the positional shape instead.
 */
describe('pinnedLookup', () => {
  /** The hook as Node actually calls it; Node's own type covers one shape only. */
  type Hook = (
    hostname: string,
    options: { all?: boolean },
    callback: (err: unknown, addresses: unknown, family?: number) => void,
  ) => void;

  const hook = (address: string): Hook => pinnedLookup(address) as unknown as Hook;

  it('answers happy-eyeballs lookups (all: true) with an array of addresses', () => {
    const callback = vi.fn();
    hook('203.0.113.7')('example.com', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: '203.0.113.7', family: 4 }]);
  });

  it('answers the positional shape when all is not set', () => {
    const callback = vi.fn();
    hook('203.0.113.7')('example.com', {}, callback);

    expect(callback).toHaveBeenCalledWith(null, '203.0.113.7', 4);
  });

  it('reports family 6 for an IPv6 address', () => {
    const callback = vi.fn();
    hook('2001:db8::1')('example.com', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: '2001:db8::1', family: 6 }]);
  });

  it("connects through Node's real transport", async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          // The name never resolves: only the pinned address can answer.
          { host: 'pinned.invalid', port, path: '/', lookup: pinnedLookup('127.0.0.1') },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(status).toBe(200);
    } finally {
      server.close();
    }
  });
});
