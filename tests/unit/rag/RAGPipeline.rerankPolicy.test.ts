/**
 * RAGPipeline — re-ranker failure policy.
 *
 * The re-ranker is the only stage that assigns absolute relevance scores.
 * Retrieval scores are min-max normalised per collection, so the top candidate
 * always scores 1.0 and `minScore` cannot discriminate without it: continuing
 * silently turns "no relevant results" into "the nearest neighbours of any
 * query". These tests pin the contract that a configured re-ranker which fails
 * surfaces an error by default, and degrades only on explicit opt-in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { RerankerError } from '../../../src/errors/RerankerError.js';
import { TokenLimitError } from '../../../src/errors/index.js';
import type {
  EmbeddingResult,
  RerankResult,
  Passage,
  VectorDocument,
  CollectionConfig,
  ProviderProbe,
} from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

class MockEmbeddingProvider extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/mock-v1';

  async embed(): Promise<EmbeddingResult> {
    return { vector: [1, 0, 0], model: 'mock-v1', dimensions: 3, tokensUsed: 5, latencyMs: 1 };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(() => this.embed()));
  }
  getDimensions(): number {
    return 3;
  }
  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }
}

/** Re-ranker whose `rerank()` always fails with the supplied error. */
class FailingReranker extends RerankerProvider {
  readonly name = 'failing-reranker';
  readonly #error: Error;
  #probe: ProviderProbe | Error = { ok: true };

  constructor(error: Error = new Error('connection refused')) {
    super();
    this.#error = error;
  }
  /** An Error models a provider that violates the no-throw contract. */
  setProbe(probe: ProviderProbe | Error): void {
    this.#probe = probe;
  }

  async rerank(): Promise<RerankResult> {
    throw this.#error;
  }

  async validate(): Promise<ProviderProbe> {
    if (this.#probe instanceof Error) throw this.#probe;
    return this.#probe;
  }
}

/** Re-ranker that succeeds, reversing the retrieval order. */
class WorkingReranker extends RerankerProvider {
  readonly name = 'working-reranker';

  async rerank(_query: string, passages: Passage[], topK: number): Promise<RerankResult> {
    const reversed = [...passages]
      .reverse()
      .slice(0, topK)
      .map((p, i) => ({ ...p, score: 1 / (i + 1) }));
    return { passages: reversed, model: 'working-reranker', latencyMs: 5, tokensUsed: 0 };
  }
  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTION = 'policy-docs';

const COLLECTION_CONFIG: CollectionConfig = {
  dimensions: 3,
  distanceMetric: 'cosine',
  embeddingProvider: 'mock',
  embeddingModel: 'mock/mock-v1',
};

const CONTEXT: ExecutionContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  roles: ['reader'],
  sessionId: 'sess-1',
  agentId: 'agent-1',
  requestId: 'req-1',
};

function makeDoc(id: string, vector: number[], content: string): VectorDocument {
  return { id, content, vector, metadata: { documentId: id } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline — rerankPolicy', () => {
  let store: InMemoryVectorStore;
  let embeddingRouter: EmbeddingRouter;
  let bus: EventBus;
  let tokens: TokenTracker;

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    await store.createCollection(COLLECTION, COLLECTION_CONFIG);
    await store.upsert(COLLECTION, [
      makeDoc('close', [1, 0, 0], 'quarterly earnings report'),
      makeDoc('far', [0, 1, 0], 'employee benefits handbook'),
    ]);

    embeddingRouter = new EmbeddingRouter();
    embeddingRouter.registerProvider(new MockEmbeddingProvider());

    bus = new EventBus();
    tokens = new TokenTracker();
  });

  describe("'require' (default)", () => {
    it('throws RerankerError when the configured re-ranker fails', async () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, new FailingReranker(), bus, tokens);

      await expect(
        pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT),
      ).rejects.toBeInstanceOf(RerankerError);
    });

    it('reports the provider, the request stage and the original cause', async () => {
      const cause = new Error('connection refused');
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(cause),
        bus,
        tokens,
      );

      await expect(
        pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT),
      ).rejects.toMatchObject({
        code: 'RERANKER_UNAVAILABLE',
        provider: 'failing-reranker',
        stage: 'request',
        cause,
      });
    });

    it('preserves a RerankerError raised by the re-ranker itself', async () => {
      const original = new RerankerError('llm', 'parse', 'model returned prose');
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(original),
        bus,
        tokens,
      );

      await expect(
        pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT),
      ).rejects.toMatchObject({ stage: 'parse', provider: 'llm' });
    });

    it('emits rag.rerank.error before throwing', async () => {
      const emitSpy = vi.spyOn(bus, 'emit');
      const pipeline = new RAGPipeline(embeddingRouter, store, new FailingReranker(), bus, tokens);

      await expect(
        pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT),
      ).rejects.toBeInstanceOf(RerankerError);

      expect(emitSpy).toHaveBeenCalledWith(
        'rag.rerank.error',
        expect.objectContaining({
          policy: 'require',
        }),
      );
    });

    it('does not throw when no re-ranker is configured (absence is not failure)', async () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);

      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION], rerank: true },
        CONTEXT,
      );

      expect(result.reranked).toBe(false);
      expect(result.passages.length).toBeGreaterThan(0);
    });

    it('does not throw when the query opts out of re-ranking', async () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, new FailingReranker(), bus, tokens);

      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION], rerank: false },
        CONTEXT,
      );

      expect(result.reranked).toBe(false);
    });
  });

  describe("'degrade'", () => {
    it('falls back to retrieval order instead of throwing', async () => {
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(),
        bus,
        tokens,
        undefined,
        'degrade',
      );

      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION] },
        CONTEXT,
      );

      expect(result.reranked).toBe(false);
      expect(result.passages[0]!.id).toBe('close');
    });

    it('still emits rag.rerank.error, tagged with the policy', async () => {
      const emitSpy = vi.spyOn(bus, 'emit');
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(),
        bus,
        tokens,
        undefined,
        'degrade',
      );

      await pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT);

      expect(emitSpy).toHaveBeenCalledWith(
        'rag.rerank.error',
        expect.objectContaining({
          policy: 'degrade',
        }),
      );
    });
  });

  describe('per-query override', () => {
    it("query 'degrade' overrides a 'require' default", async () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, new FailingReranker(), bus, tokens);

      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION], rerankPolicy: 'degrade' },
        CONTEXT,
      );

      expect(result.reranked).toBe(false);
    });

    it("query 'require' overrides a 'degrade' default", async () => {
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(),
        bus,
        tokens,
        undefined,
        'degrade',
      );

      await expect(
        pipeline.search(
          { query: 'earnings', collections: [COLLECTION], rerankPolicy: 'require' },
          CONTEXT,
        ),
      ).rejects.toBeInstanceOf(RerankerError);
    });
  });

  it('propagates TokenLimitError untouched under either policy', async () => {
    const limit = new TokenLimitError(
      'tenant-1',
      {
        scope: 'user',
        window: 'daily',
        used: 10,
        projected: 20,
        limit: 15,
        remaining: 5,
        resetAt: new Date(0),
      },
      'user-1',
    );

    for (const policy of ['require', 'degrade'] as const) {
      const pipeline = new RAGPipeline(
        embeddingRouter,
        store,
        new FailingReranker(limit),
        bus,
        tokens,
        undefined,
        policy,
      );
      await expect(
        pipeline.search({ query: 'earnings', collections: [COLLECTION] }, CONTEXT),
      ).rejects.toBeInstanceOf(TokenLimitError);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup probe
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline — validateReranker', () => {
  let store: InMemoryVectorStore;
  let embeddingRouter: EmbeddingRouter;
  let bus: EventBus;
  let tokens: TokenTracker;

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    await store.createCollection(COLLECTION, COLLECTION_CONFIG);
    embeddingRouter = new EmbeddingRouter();
    embeddingRouter.registerProvider(new MockEmbeddingProvider());
    bus = new EventBus();
    tokens = new TokenTracker();
  });

  it('reports a healthy re-ranker as configured and available', async () => {
    const pipeline = new RAGPipeline(embeddingRouter, store, new WorkingReranker(), bus, tokens);

    const result = await pipeline.validateReranker();

    expect(result).toMatchObject({
      configured: true,
      available: true,
      provider: 'working-reranker',
    });
  });

  it('distinguishes "none configured" from "configured but down"', async () => {
    const none = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
    expect(await none.validateReranker()).toMatchObject({ configured: false, available: false });

    const down = new FailingReranker();
    down.setProbe({ ok: false, error: 'ECONNREFUSED' });
    const pipeline = new RAGPipeline(embeddingRouter, store, down, bus, tokens);

    expect(await pipeline.validateReranker()).toMatchObject({
      configured: true,
      available: false,
      provider: 'failing-reranker',
      error: 'ECONNREFUSED',
    });
  });

  it('falls back to a generic message when the provider reports no reason', async () => {
    const reranker = new FailingReranker();
    reranker.setProbe({ ok: false });
    const pipeline = new RAGPipeline(embeddingRouter, store, reranker, bus, tokens);

    const result = await pipeline.validateReranker();

    expect(result.available).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('survives a provider that throws instead of honouring the contract', async () => {
    const reranker = new FailingReranker();
    reranker.setProbe(new Error('boom'));
    const pipeline = new RAGPipeline(embeddingRouter, store, reranker, bus, tokens);

    // A health check that crashes the boot sequence would defeat its purpose.
    expect(await pipeline.validateReranker()).toMatchObject({
      configured: true,
      available: false,
      error: 'boom',
    });
  });

  it('emits rag.reranker.unavailable, carrying the reason, when the probe fails', async () => {
    const emitSpy = vi.spyOn(bus, 'emit');
    const reranker = new FailingReranker();
    reranker.setProbe({ ok: false, error: 'ECONNREFUSED' });
    const pipeline = new RAGPipeline(embeddingRouter, store, reranker, bus, tokens);

    await pipeline.validateReranker();

    expect(emitSpy).toHaveBeenCalledWith(
      'rag.reranker.unavailable',
      expect.objectContaining({
        provider: 'failing-reranker',
        error: 'ECONNREFUSED',
      }),
    );
  });
});
