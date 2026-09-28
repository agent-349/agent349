/**
 * Tests for RAGPipeline multi-collection validation (P1 fix).
 *
 * Verifies that querying collections with incompatible embedding providers
 * throws RAGError, and that querying collections with the same provider works.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { RAGError } from '../../../src/errors/RAGError.js';
import type { EmbeddingResult, CollectionConfig } from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

class MockProvider extends EmbeddingProvider {
  readonly model = 'mock-model';
  constructor(public readonly name: string) {
    super();
  }
  getDimensions(): number {
    return 3;
  }
  async validate(): Promise<boolean> {
    return true;
  }
  async embed(_text: string): Promise<EmbeddingResult> {
    return {
      vector: [1, 0, 0],
      model: `${this.name}/mock`,
      dimensions: 3,
      tokensUsed: 1,
      latencyMs: 0,
    };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function makeCollection(embeddingModel: string): CollectionConfig {
  return {
    embeddingProvider: embeddingModel.split('/')[0]!,
    embeddingModel,
    dimensions: 3,
    distanceMetric: 'cosine',
  };
}

const ctx: ExecutionContext = {
  tenantId: 'test',
  userId: 'u1',
  roles: ['user'],
  sessionId: 'sess',
  requestId: 'req',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline — multi-collection provider validation', () => {
  let store: InMemoryVectorStore;
  let router: EmbeddingRouter;
  let pipeline: RAGPipeline;

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    router = new EmbeddingRouter();
    router.registerProvider(new MockProvider('openai'));
    router.registerProvider(new MockProvider('cohere'));

    pipeline = new RAGPipeline(router, store, undefined, new EventBus(), new TokenTracker());

    await store.createCollection('col-openai', makeCollection('openai/text-embedding-3-small'));
    await store.createCollection('col-cohere', makeCollection('cohere/embed-v4.0'));
    await store.createCollection('col-openai-2', makeCollection('openai/text-embedding-3-large'));
  });

  it('throws RAGError when collections use different embedding providers', async () => {
    await expect(
      pipeline.search({ query: 'test', collections: ['col-openai', 'col-cohere'] }, ctx),
    ).rejects.toThrow(RAGError);
  });

  it('RAGError message names the conflicting providers', async () => {
    await expect(
      pipeline.search({ query: 'test', collections: ['col-openai', 'col-cohere'] }, ctx),
    ).rejects.toThrow(/openai.*cohere|cohere.*openai/i);
  });

  it('does not throw when all collections use the same provider', async () => {
    // Both col-openai and col-openai-2 use the 'openai' provider.
    await expect(
      pipeline.search({ query: 'test', collections: ['col-openai', 'col-openai-2'] }, ctx),
    ).resolves.toBeDefined();
  });

  it('does not throw when a single collection is queried', async () => {
    await expect(
      pipeline.search({ query: 'test', collections: ['col-cohere'] }, ctx),
    ).resolves.toBeDefined();
  });

  it('throws RAGError when collection has no metadata (embeddingModel empty)', async () => {
    // Simulate a collection created outside the SDK — no metadata available.
    // InMemoryVectorStore returns embeddingModel: '' for such collections
    // only if not created with a config. Here we test via an unknown collection name.
    // The pipeline should throw because it cannot resolve the provider.
    const emptyStore = new InMemoryVectorStore();
    await emptyStore.createCollection('no-meta', {
      embeddingProvider: '',
      embeddingModel: '',
      dimensions: 3,
      distanceMetric: 'cosine',
    });
    const p = new RAGPipeline(router, emptyStore, undefined, new EventBus(), new TokenTracker());

    await expect(p.search({ query: 'test', collections: ['no-meta'] }, ctx)).rejects.toThrow(
      RAGError,
    );
  });
});
