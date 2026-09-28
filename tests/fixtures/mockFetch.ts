import type { FetchLike } from '../../src/rag/vectorstore/common.js';

/** A recorded request made through {@link mockFetch}. */
export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// A JSON body, or `{ status, body }` to control the HTTP status.
type Handler = (req: RecordedRequest) => unknown;

/** A route: method + path pattern → JSON response (or `{ status, body }`). */
export interface Route {
  method: string;
  path: RegExp;
  reply: Handler;
}

/**
 * Minimal fake `fetch` for HTTP-based adapters. Unmatched requests fail with
 * HTTP 404, which is also how "not found" is exercised.
 */
export function mockFetch(routes: Route[]): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: input,
      path: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(req);
    const route = routes.find((r) => r.method === req.method && r.path.test(req.path));
    if (route === undefined) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const out = route.reply(req);
    if (typeof out === 'object' && out !== null && 'status' in out && 'body' in out) {
      const { status, body } = out as { status: number; body: unknown };
      return new Response(JSON.stringify(body), { status });
    }
    return new Response(out === undefined ? '' : JSON.stringify(out), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}
