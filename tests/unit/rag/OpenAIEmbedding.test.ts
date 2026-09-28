import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIEmbeddingProvider } from '../../../src/rag/embedding/OpenAIEmbedding.js';
import { ProviderError } from '../../../src/errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEmbeddingResponse(
  data: Array<{ embedding: number[]; index: number }>,
  promptTokens = 10,
  model = 'text-embedding-3-small',
): OpenAI.CreateEmbeddingResponse {
  return {
    object: 'list',
    model,
    data: data.map((d) => ({ object: 'embedding' as const, ...d })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

function makeMockClient(response: OpenAI.CreateEmbeddingResponse): OpenAI {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue(response),
    },
  } as unknown as OpenAI;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIEmbeddingProvider', () => {
  describe('identity', () => {
    it('has name "openai"', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [0.1], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      expect(provider.name).toBe('openai');
    });

    it('defaults to text-embedding-3-small model', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [0.1], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      expect(provider.model).toBe('text-embedding-3-small');
    });

    it('uses provided model', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [0.1], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider(
        { apiKey: 'sk-test', model: 'text-embedding-3-large' },
        client,
      );
      expect(provider.model).toBe('text-embedding-3-large');
    });
  });

  describe('getDimensions()', () => {
    it('returns 1536 for text-embedding-3-small (default)', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      expect(provider.getDimensions()).toBe(1536);
    });

    it('returns 3072 for text-embedding-3-large', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider(
        { apiKey: 'sk-test', model: 'text-embedding-3-large' },
        client,
      );
      expect(provider.getDimensions()).toBe(3072);
    });

    it('returns 1536 for text-embedding-ada-002', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider(
        { apiKey: 'sk-test', model: 'text-embedding-ada-002' },
        client,
      );
      expect(provider.getDimensions()).toBe(1536);
    });

    it('returns 1536 as default for unknown model', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider(
        { apiKey: 'sk-test', model: 'some-future-model' },
        client,
      );
      expect(provider.getDimensions()).toBe(1536);
    });

    it('returns custom dimensions when configured', () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test', dimensions: 512 }, client);
      expect(provider.getDimensions()).toBe(512);
    });
  });

  describe('embed()', () => {
    let client: OpenAI;
    let provider: OpenAIEmbeddingProvider;
    const vector = [0.1, 0.2, 0.3];

    beforeEach(() => {
      client = makeMockClient(
        makeEmbeddingResponse([{ embedding: vector, index: 0 }], 8, 'text-embedding-3-small'),
      );
      provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
    });

    it('returns correct vector', async () => {
      const result = await provider.embed('hello world');
      expect(result.vector).toEqual(vector);
    });

    it('returns correct dimensions', async () => {
      const result = await provider.embed('hello world');
      expect(result.dimensions).toBe(vector.length);
    });

    it('returns model from API response', async () => {
      const result = await provider.embed('hello world');
      expect(result.model).toBe('text-embedding-3-small');
    });

    it('returns tokensUsed from prompt_tokens', async () => {
      const result = await provider.embed('hello world');
      expect(result.tokensUsed).toBe(8);
    });

    it('returns a non-negative latencyMs', async () => {
      const result = await provider.embed('hello world');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('calls API with correct model and input', async () => {
      await provider.embed('my text');
      expect(client.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'my text',
      });
    });

    it('passes dimensions param when configured', async () => {
      const p = new OpenAIEmbeddingProvider({ apiKey: 'sk-test', dimensions: 256 }, client);
      await p.embed('test');
      expect(client.embeddings.create).toHaveBeenCalledWith(
        expect.objectContaining({ dimensions: 256 }),
      );
    });

    it('does NOT pass dimensions param when not configured', async () => {
      await provider.embed('test');
      const call = (client.embeddings.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call).not.toHaveProperty('dimensions');
    });

    it('wraps OpenAI APIError into ProviderError', async () => {
      const OpenAIModule = await import('openai');
      const mockHeaders = { get: vi.fn().mockReturnValue(null) } as unknown as Headers;
      const fakeApiError = new OpenAIModule.default.APIError(
        401,
        undefined,
        'invalid api key',
        mockHeaders,
      );
      const badClient = {
        embeddings: { create: vi.fn().mockRejectedValue(fakeApiError) },
      } as unknown as OpenAI;
      const p = new OpenAIEmbeddingProvider({ apiKey: 'bad' }, badClient);
      await expect(p.embed('test')).rejects.toBeInstanceOf(ProviderError);
    });

    it('re-throws non-OpenAI errors unchanged', async () => {
      const plainError = new Error('network failure');
      const badClient = {
        embeddings: { create: vi.fn().mockRejectedValue(plainError) },
      } as unknown as OpenAI;
      const p = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, badClient);
      await expect(p.embed('test')).rejects.toBe(plainError);
    });
  });

  describe('embedBatch()', () => {
    it('returns results in input order even if API returns out of order', async () => {
      const vec0 = [0.1, 0.2];
      const vec1 = [0.3, 0.4];
      const vec2 = [0.5, 0.6];
      // API returns items in scrambled index order
      const client = makeMockClient(
        makeEmbeddingResponse(
          [
            { embedding: vec2, index: 2 },
            { embedding: vec0, index: 0 },
            { embedding: vec1, index: 1 },
          ],
          30,
        ),
      );
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      const results = await provider.embedBatch(['a', 'b', 'c']);
      expect(results[0].vector).toEqual(vec0);
      expect(results[1].vector).toEqual(vec1);
      expect(results[2].vector).toEqual(vec2);
    });

    it('uses a single API call for the whole batch', async () => {
      const client = makeMockClient(
        makeEmbeddingResponse(
          [
            { embedding: [1], index: 0 },
            { embedding: [2], index: 1 },
          ],
          20,
        ),
      );
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      await provider.embedBatch(['text1', 'text2']);
      expect(client.embeddings.create).toHaveBeenCalledTimes(1);
      expect(client.embeddings.create).toHaveBeenCalledWith(
        expect.objectContaining({ input: ['text1', 'text2'] }),
      );
    });

    it('distributes token usage evenly across items', async () => {
      const client = makeMockClient(
        makeEmbeddingResponse(
          [
            { embedding: [1], index: 0 },
            { embedding: [2], index: 1 },
            { embedding: [3], index: 2 },
          ],
          30,
        ),
      );
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      const results = await provider.embedBatch(['a', 'b', 'c']);
      expect(results[0].tokensUsed).toBe(10);
      expect(results[1].tokensUsed).toBe(10);
      expect(results[2].tokensUsed).toBe(10);
    });

    it('returns correct dimensions for each item', async () => {
      const client = makeMockClient(
        makeEmbeddingResponse([{ embedding: [0.1, 0.2, 0.3], index: 0 }], 5),
      );
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      const results = await provider.embedBatch(['hello']);
      expect(results[0].dimensions).toBe(3);
    });

    it('wraps OpenAI APIError into ProviderError', async () => {
      const OpenAIModule = await import('openai');
      const mockHeaders = { get: vi.fn().mockReturnValue(null) } as unknown as Headers;
      const fakeApiError = new OpenAIModule.default.APIError(
        429,
        undefined,
        'rate limit',
        mockHeaders,
      );
      const badClient = {
        embeddings: { create: vi.fn().mockRejectedValue(fakeApiError) },
      } as unknown as OpenAI;
      const p = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, badClient);
      await expect(p.embedBatch(['a', 'b'])).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('validate()', () => {
    it('returns true when embed succeeds', async () => {
      const client = makeMockClient(makeEmbeddingResponse([{ embedding: [0.1], index: 0 }]));
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-test' }, client);
      expect(await provider.validate()).toEqual({ ok: true });
    });

    it('reports the reason when embed throws', async () => {
      const badClient = {
        embeddings: { create: vi.fn().mockRejectedValue(new Error('auth error')) },
      } as unknown as OpenAI;
      const provider = new OpenAIEmbeddingProvider({ apiKey: 'bad' }, badClient);
      const probe = await provider.validate();
      expect(probe.ok).toBe(false);
      expect(probe.error).toBeDefined();
    });
  });
});
