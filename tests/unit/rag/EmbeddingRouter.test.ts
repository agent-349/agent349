import { describe, it, expect, vi } from 'vitest';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { EmbeddingResult } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock provider
// ─────────────────────────────────────────────────────────────────────────────

function makeResult(vector: number[]): EmbeddingResult {
  return { vector, model: 'mock-model', dimensions: vector.length, tokensUsed: 5, latencyMs: 10 };
}

class MockEmbeddingProvider extends EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly #dims: number;
  readonly embed = vi.fn<[string], Promise<EmbeddingResult>>();
  readonly embedBatch = vi.fn<[string[]], Promise<EmbeddingResult[]>>();

  constructor(name: string, model = 'mock-model', dims = 128) {
    super();
    this.name = name;
    this.model = model;
    this.#dims = dims;
  }

  getDimensions(): number {
    return this.#dims;
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbeddingRouter', () => {
  describe('constructor', () => {
    it('starts empty with no args', () => {
      const router = new EmbeddingRouter();
      expect(router.listProviders()).toEqual([]);
    });

    it('accepts initial provider map', () => {
      const p = new MockEmbeddingProvider('openai');
      const router = new EmbeddingRouter(new Map([['openai', p]]));
      expect(router.listProviders()).toContain('openai');
    });
  });

  describe('registerProvider()', () => {
    it('adds a new provider', () => {
      const router = new EmbeddingRouter();
      router.registerProvider(new MockEmbeddingProvider('cohere'));
      expect(router.listProviders()).toContain('cohere');
    });

    it('replaces existing provider with same name', () => {
      const router = new EmbeddingRouter();
      const p1 = new MockEmbeddingProvider('openai', 'model-v1', 512);
      const p2 = new MockEmbeddingProvider('openai', 'model-v2', 1024);
      router.registerProvider(p1);
      router.registerProvider(p2);
      expect(router.getProviderInfo('openai').model).toBe('model-v2');
      expect(router.listProviders()).toHaveLength(1);
    });
  });

  describe('listProviders()', () => {
    it('returns all registered provider names', () => {
      const router = new EmbeddingRouter();
      router.registerProvider(new MockEmbeddingProvider('openai'));
      router.registerProvider(new MockEmbeddingProvider('cohere'));
      expect(router.listProviders()).toEqual(expect.arrayContaining(['openai', 'cohere']));
    });
  });

  describe('embed()', () => {
    it('delegates to the correct provider', async () => {
      const provider = new MockEmbeddingProvider('openai');
      provider.embed.mockResolvedValue(makeResult([0.1, 0.2]));
      const router = new EmbeddingRouter(new Map([['openai', provider]]));

      const result = await router.embed('hello', 'openai');
      expect(result.vector).toEqual([0.1, 0.2]);
      expect(provider.embed).toHaveBeenCalledWith('hello');
    });

    it('throws ProviderError for unregistered provider', async () => {
      const router = new EmbeddingRouter();
      await expect(router.embed('hello', 'nonexistent')).rejects.toBeInstanceOf(ProviderError);
    });

    it('propagates provider errors', async () => {
      const provider = new MockEmbeddingProvider('openai');
      provider.embed.mockRejectedValue(new ProviderError('openai', 'API failure'));
      const router = new EmbeddingRouter(new Map([['openai', provider]]));
      await expect(router.embed('hello', 'openai')).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('embedBatch()', () => {
    it('delegates to the correct provider', async () => {
      const provider = new MockEmbeddingProvider('openai');
      provider.embedBatch.mockResolvedValue([makeResult([0.1]), makeResult([0.2])]);
      const router = new EmbeddingRouter(new Map([['openai', provider]]));

      const results = await router.embedBatch(['a', 'b'], 'openai');
      expect(results).toHaveLength(2);
      expect(provider.embedBatch).toHaveBeenCalledWith(['a', 'b']);
    });

    it('throws ProviderError for unregistered provider', async () => {
      const router = new EmbeddingRouter();
      await expect(router.embedBatch(['a', 'b'], 'missing')).rejects.toBeInstanceOf(ProviderError);
    });

    it('routes correctly to different providers', async () => {
      const openai = new MockEmbeddingProvider('openai');
      const cohere = new MockEmbeddingProvider('cohere');
      openai.embedBatch.mockResolvedValue([makeResult([1, 0])]);
      cohere.embedBatch.mockResolvedValue([makeResult([0, 1])]);

      const router = new EmbeddingRouter(
        new Map([
          ['openai', openai],
          ['cohere', cohere],
        ]),
      );

      const [r1] = await router.embedBatch(['doc'], 'openai');
      const [r2] = await router.embedBatch(['doc'], 'cohere');
      expect(r1.vector).toEqual([1, 0]);
      expect(r2.vector).toEqual([0, 1]);
      expect(openai.embedBatch).toHaveBeenCalledTimes(1);
      expect(cohere.embedBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getProviderInfo()', () => {
    it('returns name, model, and dimensions', () => {
      const provider = new MockEmbeddingProvider('openai', 'text-embedding-3-small', 1536);
      const router = new EmbeddingRouter(new Map([['openai', provider]]));
      const info = router.getProviderInfo('openai');
      expect(info).toEqual({ name: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
    });

    it('throws ProviderError for unregistered provider', () => {
      const router = new EmbeddingRouter();
      expect(() => router.getProviderInfo('ghost')).toThrow(ProviderError);
    });
  });
});
