import { describe, it, expect, vi, afterEach } from 'vitest';
import { TEIReranker } from '../../../src/rag/reranker/TEIReranker.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { Passage } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function passage(id: string, content: string): Passage {
  return { id, content, score: 0, collection: 'c', metadata: { documentId: id } };
}

function makePassages(n: number): Passage[] {
  return Array.from({ length: n }, (_, i) => passage(`p${i}`, `content ${i}`));
}

interface FetchResult {
  ok?: boolean;
  status?: number;
  body?: unknown;
  retryAfter?: string;
  reject?: boolean;
}

function fetchResponse(r: FetchResult): unknown {
  if (r.reject) return Promise.reject(new Error('ECONNREFUSED'));
  return Promise.resolve({
    ok: r.ok ?? true,
    status: r.status ?? 200,
    json: async () => r.body,
    text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '')),
    headers: {
      get: (h: string) => (h.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null),
    },
  });
}

function mockFetch(...results: FetchResult[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of results) fn.mockImplementationOnce(() => fetchResponse(r));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TEIReranker — core', () => {
  it('reranks by score, maps indices to passages, and slices topK', async () => {
    mockFetch({
      body: [
        { index: 0, score: 0.2 },
        { index: 1, score: 0.9 },
        { index: 2, score: 0.5 },
      ],
    });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090' });
    const res = await r.rerank('q', makePassages(3), 2);

    expect(res.passages.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(res.passages[0]!.score).toBe(0.9);
    expect(res.model).toBe('tei');
    expect(res.tokensUsed).toBe(0);
  });

  it('sends {query, texts, raw_scores} to /rerank without a model field', async () => {
    const fn = mockFetch({ body: [{ index: 0, score: 0.5 }] });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090/', modelLabel: 'bge' });
    await r.rerank('hello', [passage('p0', 'doc')], 1);

    const [url, init] = fn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://tei:8090/rerank');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ query: 'hello', texts: ['doc'], raw_scores: false });
    expect(body).not.toHaveProperty('model');
  });

  it('uses modelLabel as the observability identity', async () => {
    mockFetch({ body: [{ index: 0, score: 0.5 }] });
    const r = new TEIReranker({
      baseUrl: 'http://tei:8090',
      modelLabel: 'BAAI/bge-reranker-v2-m3',
    });
    const res = await r.rerank('q', [passage('p0', 'd')], 1);
    expect(res.model).toBe('BAAI/bge-reranker-v2-m3');
  });

  it('returns empty without calling the API for no passages', async () => {
    const fn = mockFetch();
    const r = new TEIReranker({ baseUrl: 'http://tei:8090' });
    const res = await r.rerank('q', [], 5);
    expect(res.passages).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('adds a bearer header from apiKey, not overriding an explicit Authorization', async () => {
    const fn = mockFetch({ body: [{ index: 0, score: 1 }] }, { body: [{ index: 0, score: 1 }] });
    const withKey = new TEIReranker({ baseUrl: 'http://tei:8090', apiKey: 'secret' });
    await withKey.rerank('q', [passage('p0', 'd')], 1);
    expect((fn.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret',
    });

    const withHeader = new TEIReranker({
      baseUrl: 'http://tei:8090',
      apiKey: 'secret',
      headers: { Authorization: 'Custom xyz' },
    });
    await withHeader.rerank('q', [passage('p0', 'd')], 1);
    expect((fn.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Custom xyz',
    });
  });
});

describe('TEIReranker — response validation', () => {
  it('ignores out-of-range, duplicate, and non-finite scores', async () => {
    mockFetch({
      body: [
        { index: 0, score: 0.4 },
        { index: 5, score: 0.99 }, // out of range
        { index: 0, score: 0.8 }, // duplicate
        { index: 1, score: Number.NaN }, // invalid score
      ],
    });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090' });
    const res = await r.rerank('q', makePassages(2), 5);
    // Only the first valid entry survives.
    expect(res.passages.map((p) => p.id)).toEqual(['p0']);
    expect(res.passages[0]!.score).toBe(0.4);
  });

  it('throws ProviderError on a non-array response', async () => {
    mockFetch({ body: { results: [] } });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090' });
    await expect(r.rerank('q', makePassages(1), 1)).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on a non-retriable HTTP error', async () => {
    mockFetch({ ok: false, status: 400, body: 'bad request' });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090' });
    await expect(r.rerank('q', makePassages(1), 1)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('TEIReranker — resilience', () => {
  it('retries on 429 (honouring Retry-After) then succeeds', async () => {
    const fn = mockFetch(
      { ok: false, status: 429, body: 'slow down', retryAfter: '0' },
      { body: [{ index: 0, score: 0.7 }] },
    );
    const r = new TEIReranker({ baseUrl: 'http://tei:8090', maxRetries: 1 });
    const res = await r.rerank('q', makePassages(1), 1);
    expect(res.passages[0]!.id).toBe('p0');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('surfaces a ProviderError after exhausting retries on 5xx', async () => {
    mockFetch({ ok: false, status: 503, body: 'unavailable' });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090', maxRetries: 0 });
    await expect(r.rerank('q', makePassages(1), 1)).rejects.toBeInstanceOf(ProviderError);
  });

  it('retries a network error then succeeds', async () => {
    const fn = mockFetch({ reject: true }, { body: [{ index: 0, score: 0.6 }] });
    const r = new TEIReranker({ baseUrl: 'http://tei:8090', maxRetries: 1 });
    // Backoff for a network error is small (250ms); keep the test tolerant.
    const res = await r.rerank('q', makePassages(1), 1);
    expect(res.passages[0]!.id).toBe('p0');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('TEIReranker — batching', () => {
  it('splits into batches, merges globally, and keeps scores comparable', async () => {
    // 4 passages, batch size 2 → two requests. Global ranking spans batches.
    const fn = mockFetch(
      {
        body: [
          { index: 0, score: 0.1 },
          { index: 1, score: 0.95 },
        ],
      },
      {
        body: [
          { index: 0, score: 0.5 },
          { index: 1, score: 0.3 },
        ],
      },
    );
    const r = new TEIReranker({ baseUrl: 'http://tei:8090', maxBatchSize: 2, concurrency: 1 });
    const res = await r.rerank('q', makePassages(4), 3);

    expect(fn).toHaveBeenCalledTimes(2);
    // p1 (0.95) from batch 1, p2 (0.5) from batch 2, p3 (0.3) from batch 2.
    expect(res.passages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    // Second batch texts are the 3rd/4th passages.
    const secondBody = JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.texts).toEqual(['content 2', 'content 3']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup probe
// ─────────────────────────────────────────────────────────────────────────────

describe('TEIReranker — validate', () => {
  it('reports ok when the endpoint answers', async () => {
    mockFetch({ body: [{ index: 0, score: 0.9 }] });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test' });

    expect(await reranker.validate()).toEqual({ ok: true });
  });

  it('reports the underlying cause when unreachable', async () => {
    // The retry policy attempts the request more than once before giving up.
    mockFetch({ reject: true }, { reject: true }, { reject: true });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test', maxRetries: 0 });

    const probe = await reranker.validate();

    // "unreachable" and "rejected the request" call for different operational
    // responses, so the probe carries the reason rather than a bare false.
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('ECONNREFUSED');
  });

  it('does not throw when the endpoint rejects the probe', async () => {
    mockFetch({ ok: false, status: 401, body: 'unauthorized' });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test', maxRetries: 0 });

    const probe = await reranker.validate();

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('401');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring text
// ─────────────────────────────────────────────────────────────────────────────

describe('TEIReranker — scoring text', () => {
  function titled(id: string, content: string, title: string): Passage {
    return { id, content, score: 0, collection: 'c', metadata: { documentId: id, title } };
  }

  it('sends the document title along with the chunk', async () => {
    const fn = mockFetch({ body: [{ index: 0, score: 0.9 }] });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test' });

    await reranker.rerank(
      'do we have a covid circular?',
      [
        titled(
          'p1',
          'COVID-19 - INSPECCIONES MTSS. El MTSS realiza inspecciones...',
          'Circular 21.0070 - COVID-19.pdf',
        ),
      ],
      1,
    );

    // Without the title the chunk never states it is a circular, and a query
    // naming the document by type scores near zero.
    const body = JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string) as {
      texts: string[];
    };
    expect(body.texts[0]).toBe(
      'Circular 21.0070 - COVID-19.pdf\n\nCOVID-19 - INSPECCIONES MTSS. El MTSS realiza inspecciones...',
    );
  });

  it('does not leak the title into the returned passage', async () => {
    mockFetch({ body: [{ index: 0, score: 0.9 }] });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test' });

    const res = await reranker.rerank('q', [titled('p1', 'chunk body', 'Some Title.pdf')], 1);

    // A rewritten content would surface in UI snippets and in the LLM context.
    expect(res.passages[0]!.content).toBe('chunk body');
  });

  it('sends the content alone when the passage has no title', async () => {
    const fn = mockFetch({ body: [{ index: 0, score: 0.9 }] });
    const reranker = new TEIReranker({ baseUrl: 'http://tei.test' });

    await reranker.rerank('q', [passage('p1', 'just the body')], 1);

    const body = JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string) as {
      texts: string[];
    };
    expect(body.texts[0]).toBe('just the body');
  });
});
