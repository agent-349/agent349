/**
 * Unit tests for OllamaEmbeddingProvider.
 * All HTTP calls are intercepted via vi.stubGlobal('fetch', ...).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../../../src/rag/embedding/OllamaEmbedding.js';
import { ProviderError } from '../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(embeddings: number[][], promptEvalCount = 8): Response {
  const body = JSON.stringify({
    model: 'nomic-embed-text',
    embeddings,
    prompt_eval_count: promptEvalCount,
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaEmbeddingProvider', () => {
  let provider: OllamaEmbeddingProvider;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
  });

  it('has correct name and default model', () => {
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('nomic-embed-text');
  });

  it('uses default model when not specified', () => {
    const p = new OllamaEmbeddingProvider();
    expect(p.model).toBe('nomic-embed-text');
  });

  it('getDimensions returns 768 for nomic-embed-text', () => {
    expect(provider.getDimensions()).toBe(768);
  });

  it('getDimensions returns 1024 for mxbai-embed-large', () => {
    const p = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large' });
    expect(p.getDimensions()).toBe(1024);
  });

  it('getDimensions returns 768 as fallback for unknown models', () => {
    const p = new OllamaEmbeddingProvider({ model: 'unknown-model' });
    expect(p.getDimensions()).toBe(768);
  });

  it('embed returns correct EmbeddingResult', async () => {
    const vector = [0.5, 0.6, 0.7];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse([vector], 4)));

    const result = await provider.embed('hello');

    expect(result.vector).toEqual(vector);
    expect(result.dimensions).toBe(3);
    expect(result.tokensUsed).toBe(4);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    vi.unstubAllGlobals();
  });

  it('embedBatch returns one result per input text', async () => {
    const v1 = [1, 0];
    const v2 = [0, 1];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse([v1, v2])));

    const results = await provider.embedBatch(['foo', 'bar']);

    expect(results).toHaveLength(2);
    expect(results[0]!.vector).toEqual(v1);
    expect(results[1]!.vector).toEqual(v2);

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));

    await expect(provider.embed('test')).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('throws ProviderError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(provider.embed('test')).rejects.toThrow(ProviderError);

    vi.unstubAllGlobals();
  });

  it('validate reports the reason when the server is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const probe = await provider.validate();
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('calls the correct Ollama endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([[0.1]]));
    vi.stubGlobal('fetch', fetchMock);

    await provider.embed('test');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/api/embed');

    vi.unstubAllGlobals();
  });

  it('respects custom baseURL', async () => {
    const p = new OllamaEmbeddingProvider({ baseURL: 'http://gpu-server:11434' });
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([[0.1]]));
    vi.stubGlobal('fetch', fetchMock);

    await p.embed('test');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://gpu-server:11434/api/embed');

    vi.unstubAllGlobals();
  });
});
