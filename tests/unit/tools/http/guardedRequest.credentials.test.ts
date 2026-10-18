import { describe, it, expect } from 'vitest';
import { guardedRequest } from '../../../../src/tools/builtin/http/guardedRequest.js';
import type { RequestPerformer } from '../../../../src/tools/builtin/http/guardedRequest.js';

/** A transport that answers with `responses` in order and records the headers of every hop. */
function recording(responses: { status: number; location?: string }[]): RequestPerformer & {
  hops: { url: string; headers: Record<string, string> }[];
} {
  const hops: { url: string; headers: Record<string, string> }[] = [];
  const fn = async (url: URL, init: { headers: Record<string, string> }) => {
    const canned = responses[Math.min(hops.length, responses.length - 1)] ?? { status: 200 };
    hops.push({ url: url.toString(), headers: { ...init.headers } });
    return {
      status: canned.status,
      headers: canned.location === undefined ? {} : { location: canned.location },
      body: 'ok',
      truncated: false,
    };
  };
  return Object.assign(fn as unknown as RequestPerformer, { hops });
}

const resolve = async (): Promise<string[]> => ['93.184.216.34'];

const SECRET_HEADERS = {
  authorization: 'Bearer s3cr3t',
  'Proxy-Authorization': 'Basic eA==',
  cookie: 'sid=1',
  'x-api-key': 'k3y',
  accept: 'application/json',
};

function request(location: string) {
  return {
    url: 'https://api.example.com/v1/items',
    method: 'GET',
    headers: SECRET_HEADERS,
    timeoutMs: 1000,
    maxBytes: 1000,
    blockPrivateAddresses: false,
    followRedirects: true,
    sensitiveHeaders: ['X-API-Key'],
    location,
  };
}

describe('guardedRequest — credentials on redirects', () => {
  it.each([
    ['https://other.example.net/steal', 'another host'],
    ['http://api.example.com/v1/items', 'the same host over plain http'],
    ['https://api.example.com:8443/v1/items', 'the same host on another port'],
  ])('drops the credentials when a redirect goes to %s (%s)', async (location) => {
    const transport = recording([{ status: 302, location }, { status: 200 }]);
    const { location: _ignored, ...options } = request(location);

    await guardedRequest(options, { performer: transport, resolve });

    expect(transport.hops[0]?.headers).toEqual(SECRET_HEADERS);
    expect(transport.hops[1]?.url).toBe(location);
    expect(transport.hops[1]?.headers).toEqual({ accept: 'application/json' });
  });

  it('keeps them for a redirect within the same origin', async () => {
    const transport = recording([{ status: 301, location: '/v2/items' }, { status: 200 }]);
    const { location: _ignored, ...options } = request('/v2/items');

    await guardedRequest(options, { performer: transport, resolve });

    expect(transport.hops[1]?.url).toBe('https://api.example.com/v2/items');
    expect(transport.hops[1]?.headers).toEqual(SECRET_HEADERS);
  });

  it('does not get them back when a later hop returns to the original origin', async () => {
    const transport = recording([
      { status: 302, location: 'https://cdn.example.net/x' },
      { status: 302, location: 'https://api.example.com/v1/items' },
      { status: 200 },
    ]);
    const { location: _ignored, ...options } = request('');

    await guardedRequest(options, { performer: transport, resolve });

    expect(transport.hops[2]?.headers).toEqual({ accept: 'application/json' });
  });
});
