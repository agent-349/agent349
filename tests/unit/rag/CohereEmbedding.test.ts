/**
 * Unit tests for CohereEmbeddingProvider.
 * All HTTP calls are intercepted via vi.stubGlobal('fetch', ...).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CohereEmbeddingProvider } from '../../../src/rag/embedding/CohereEmbedding.js';
import { ProviderError } from '../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(embeddings: number[][], inputTokens = 10): Response {
  const body = JSON.stringify({
    id: 'test-id',
    embeddings: { float: embeddings },
    meta: { billed_units: { input_tokens: inputTokens } },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(message, { status });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CohereEmbeddingProvider', () => {
  let provider: CohereEmbeddingProvider;

  beforeEach(() => {
    provider = new CohereEmbeddingProvider({ apiKey: 'test-key', model: 'embed-v4.0' });
  });

  it('has correct name and default model', () => {
    expect(provider.name).toBe('cohere');
    expect(provider.model).toBe('embed-v4.0');
  });

  it('uses default model when not specified', () => {
    const p = new CohereEmbeddingProvider({ apiKey: 'k' });
    expect(p.model).toBe('embed-v4.0');
  });

  it('getDimensions returns known dimensions for embed-v4.0', () => {
    expect(provider.getDimensions()).toBe(1536);
  });

  it('getDimensions returns 384 for light models', () => {
    const p = new CohereEmbeddingProvider({ apiKey: 'k', model: 'embed-english-light-v3.0' });
    expect(p.getDimensions()).toBe(384);
  });

  it('getDimensions returns 1024 as fallback for unknown models', () => {
    const p = new CohereEmbeddingProvider({ apiKey: 'k', model: 'embed-unknown-v99' });
    expect(p.getDimensions()).toBe(1024);
  });

  it('embed returns correct EmbeddingResult', async () => {
    const vector = [0.1, 0.2, 0.3];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse([vector], 5)));

    const result = await provider.embed('hello world');

    expect(result.vector).toEqual(vector);
    expect(result.dimensions).toBe(3);
    expect(result.model).toBe('embed-v4.0');
    expect(result.tokensUsed).toBe(5);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    vi.unstubAllGlobals();
  });

  it('embedBatch returns results in input order', async () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse([v1, v2], 10)));

    const results = await provider.embedBatch(['first', 'second']);

    expect(results).toHaveLength(2);
    expect(results[0]!.vector).toEqual(v1);
    expect(results[1]!.vector).toEqual(v2);

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Unauthorized')));

    await expect(provider.embed('test')).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(provider.embed('test')).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('validate reports the reason when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await provider.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('sends Authorization header with Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([[0.1]]));
    vi.stubGlobal('fetch', fetchMock);

    await provider.embed('test');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');

    vi.unstubAllGlobals();
  });

  it('sends correct inputType in body', async () => {
    const p = new CohereEmbeddingProvider({ apiKey: 'k', inputType: 'search_query' });
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([[0.1]]));
    vi.stubGlobal('fetch', fetchMock);

    await p.embed('query text');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input_type: string };
    expect(body.input_type).toBe('search_query');

    vi.unstubAllGlobals();
  });
});
