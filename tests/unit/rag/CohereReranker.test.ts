/**
 * Unit tests for CohereReranker.
 * All HTTP calls are intercepted via vi.stubGlobal('fetch', ...).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CohereReranker } from '../../../src/rag/reranker/CohereReranker.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { Passage } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePassage(id: string, score = 0.5): Passage {
  return {
    id,
    content: `Content of ${id}`,
    score,
    collection: 'test',
    metadata: { documentId: id },
  };
}

function makeResponse(results: Array<{ index: number; relevance_score: number }>): Response {
  const body = JSON.stringify({
    id: 'test-id',
    results,
    meta: { billed_units: { search_units: results.length } },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CohereReranker', () => {
  let reranker: CohereReranker;

  beforeEach(() => {
    reranker = new CohereReranker({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(reranker.name).toBe('cohere');
  });

  it('returns empty result for zero passages without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await reranker.rerank('query', [], 5);

    expect(result.passages).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('reranks passages by Cohere relevance_score', async () => {
    const passages = [makePassage('p1'), makePassage('p2'), makePassage('p3')];
    // Cohere returns p2 as most relevant, then p0, then p1
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse([
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.7 },
          { index: 2, relevance_score: 0.2 },
        ]),
      ),
    );

    const result = await reranker.rerank('query', passages, 3);

    expect(result.passages[0]!.id).toBe('p2');
    expect(result.passages[0]!.score).toBeCloseTo(0.95);
    expect(result.passages[1]!.id).toBe('p1');
    expect(result.passages[2]!.id).toBe('p3');

    vi.unstubAllGlobals();
  });

  it('result has correct model and latencyMs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse([{ index: 0, relevance_score: 0.8 }])),
    );

    const result = await reranker.rerank('q', [makePassage('p1')], 1);

    expect(result.model).toBe('rerank-v3.5');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensUsed).toBe(1); // search_units = 1

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on HTTP 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );

    await expect(reranker.rerank('q', [makePassage('p1')], 1)).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(reranker.rerank('q', [makePassage('p1')], 1)).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('validate reports the reason when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const probe = await reranker.validate();
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('sends Authorization header with Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([{ index: 0, relevance_score: 0.9 }]));
    vi.stubGlobal('fetch', fetchMock);

    await reranker.rerank('q', [makePassage('p1')], 1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');

    vi.unstubAllGlobals();
  });

  it('sends top_n equal to topK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse([
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await reranker.rerank('q', [makePassage('p1'), makePassage('p2')], 2);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { top_n: number };
    expect(body.top_n).toBe(2);

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring text
// ─────────────────────────────────────────────────────────────────────────────

describe('CohereReranker — scoring text', () => {
  it('sends the title with the chunk and keeps the passage unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([{ index: 0, relevance_score: 0.9 }]));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new CohereReranker({ apiKey: 'k' });

    const p: Passage = {
      id: 'p1',
      content: 'chunk body',
      score: 0,
      collection: 'c',
      metadata: { documentId: 'p1', title: 'Circular 21.0070.pdf' },
    };
    const res = await reranker.rerank('q', [p], 1);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      documents: string[];
    };
    expect(body.documents[0]).toBe('Circular 21.0070.pdf\n\nchunk body');
    // The prefix is for scoring only; it must not reach snippets or the LLM context.
    expect(res.passages[0]!.content).toBe('chunk body');

    vi.unstubAllGlobals();
  });

  it('sends the content alone when the passage has no title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([{ index: 0, relevance_score: 0.9 }]));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new CohereReranker({ apiKey: 'k' });

    await reranker.rerank('q', [makePassage('p1')], 1);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      documents: string[];
    };
    expect(body.documents[0]).toBe('Content of p1');

    vi.unstubAllGlobals();
  });
});
