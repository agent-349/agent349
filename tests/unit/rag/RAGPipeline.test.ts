/**
 * Integration test: RAGPipeline with InMemoryVectorStore + mock embedding + mock reranker.
 *
 * This test exercises the full 4-stage pipeline (embed → search → rerank → format)
 * using only in-memory / mock components, so it runs offline without any external
 * API keys or services.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import type {
  EmbeddingResult,
  RerankResult,
  Passage,
  VectorDocument,
  CollectionConfig,
} from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mock embedding provider.
 *
 * Returns a fixed 3-D unit vector for every text, except for specific query
 * strings that are mapped to predetermined vectors for testing retrieval order.
 */
class MockEmbeddingProvider extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/mock-v1';

  readonly #queryMap: Map<string, number[]>;

  constructor(queryMap: Map<string, number[]> = new Map()) {
    super();
    this.#queryMap = queryMap;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const vector = this.#queryMap.get(text) ?? [1, 0, 0];
    return { vector, model: 'mock-v1', dimensions: vector.length, tokensUsed: 5, latencyMs: 1 };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  getDimensions(): number {
    return 3;
  }

  async validate(): Promise<boolean> {
    return true;
  }
}

/**
 * Mock reranker that returns passages in reverse order (last → first), simulating
 * a reranker that disagrees with the vector similarity ranking. Scores are set
 * to `1 / (rank + 1)` so they remain in (0, 1].
 */
class MockReranker extends RerankerProvider {
  readonly name = 'mock-reranker';

  async rerank(query: string, passages: Passage[], topK: number): Promise<RerankResult> {
    void query;
    const reversed = [...passages]
      .reverse()
      .slice(0, topK)
      .map((p, i) => ({ ...p, score: 1 / (i + 1) }));
    return { passages: reversed, model: 'mock-reranker', latencyMs: 5, tokensUsed: 0 };
  }

  async validate(): Promise<boolean> {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTION = 'test-docs';

// embeddingModel MUST be "provider/model" so the pipeline can extract the provider name.
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

function makeDoc(
  id: string,
  vector: number[],
  content: string,
  meta: Partial<VectorDocument['metadata']> = {},
): VectorDocument {
  return { id, content, vector, metadata: { documentId: id, ...meta } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline (integration)', () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Basic search — no reranker
  // ─────────────────────────────────────────────────────────────────────────

  describe('without reranker', () => {
    it('returns passages sorted by score descending', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('close', [1, 0, 0], 'quarterly earnings report'), // cosine ≈ 1
        makeDoc('far', [0, 1, 0], 'employee benefits handbook'), // cosine = 0
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      // MockEmbeddingProvider returns [1,0,0] for any query → 'close' scores highest
      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION] },
        CONTEXT,
      );

      expect(result.passages[0].id).toBe('close');
      expect(result.passages[0].score).toBeGreaterThan(result.passages[1]?.score ?? 0);
    });

    it('respects finalTopK', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'doc a'),
        makeDoc('b', [0.9, 0.1, 0], 'doc b'),
        makeDoc('c', [0.8, 0.2, 0], 'doc c'),
        makeDoc('d', [0.7, 0.3, 0], 'doc d'),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], finalTopK: 2 },
        CONTEXT,
      );

      expect(result.passages).toHaveLength(2);
    });

    it('returns correct RAGResult shape', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'hello world')]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search({ query: 'hello', collections: [COLLECTION] }, CONTEXT);

      expect(result.query).toBe('hello');
      expect(result.collections).toEqual([COLLECTION]);
      expect(result.reranked).toBe(false);
      expect(result.searchMode).toBe('hybrid');
      expect(typeof result.totalFound).toBe('number');
      expect(result.metrics).toMatchObject({
        embeddingLatencyMs: expect.any(Number),
        searchLatencyMs: expect.any(Number),
        totalLatencyMs: expect.any(Number),
      });
    });

    it('filters by minScore', async () => {
      // MockEmbeddingProvider always returns [1,0,0]
      // makeDoc 'low' has vector [0,1,0] → cosine similarity = 0 → normalised score = 0.5
      await store.upsert(COLLECTION, [
        makeDoc('high', [1, 0, 0], 'doc high'), // score ≈ 1 after normalisation
        makeDoc('low', [0, 1, 0], 'doc low'), // score ≈ 0 after normalisation
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      // Use vector-only search to get predictable scores before deduplication
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], searchMode: 'vector', minScore: 0.9 },
        CONTEXT,
      );

      // Only 'high' should exceed 0.9
      expect(result.passages.every((p) => p.score >= 0.9)).toBe(true);
    });

    it('supports vector-only search mode', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'totally unrelated content xyz'),
        makeDoc('b', [0, 1, 0], 'quarterly financial report'),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      // Mock always returns [1,0,0] → 'a' wins regardless of content
      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION], searchMode: 'vector' },
        CONTEXT,
      );

      expect(result.passages[0].id).toBe('a');
    });

    it('supports keyword-only search mode', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'quarterly earnings report'), // 'earnings' match
        makeDoc('b', [1, 0, 0], 'employee performance review'), // no match
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search(
        { query: 'earnings', collections: [COLLECTION], searchMode: 'keyword' },
        CONTEXT,
      );

      expect(result.passages.map((p) => p.id)).toContain('a');
      expect(result.passages.map((p) => p.id)).not.toContain('b');
    });

    it('emits pipeline lifecycle events', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'test')]);

      const emitted: string[] = [];
      bus.on('rag.*', (e) => emitted.push(e.type));

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      await pipeline.search({ query: 'test', collections: [COLLECTION] }, CONTEXT);

      expect(emitted).toContain('rag.embed.start');
      expect(emitted).toContain('rag.embed.end');
      expect(emitted).toContain('rag.search.start');
      expect(emitted).toContain('rag.search.end');
      expect(emitted).toContain('rag.pipeline.complete');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // With mock reranker
  // ─────────────────────────────────────────────────────────────────────────

  describe('with MockReranker', () => {
    it('marks result as reranked = true', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'test')]);

      const pipeline = new RAGPipeline(embeddingRouter, store, new MockReranker(), bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], rerank: true },
        CONTEXT,
      );

      expect(result.reranked).toBe(true);
    });

    it('reranker reverses the order produced by vector search', async () => {
      // MockReranker reverses passage order
      await store.upsert(COLLECTION, [
        makeDoc('first', [1, 0, 0], 'first passage'),
        makeDoc('second', [0.9, 0.1, 0], 'second passage'),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, new MockReranker(), bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], rerank: true, finalTopK: 2 },
        CONTEXT,
      );

      // MockReranker reverses → 'second' should now be first
      expect(result.passages[0].id).toBe('second');
    });

    it('emits rerank lifecycle events', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'test')]);

      const emitted: string[] = [];
      bus.on('rag.*', (e) => emitted.push(e.type));

      const pipeline = new RAGPipeline(embeddingRouter, store, new MockReranker(), bus, tokens);
      await pipeline.search({ query: 'test', collections: [COLLECTION], rerank: true }, CONTEXT);

      expect(emitted).toContain('rag.rerank.start');
      expect(emitted).toContain('rag.rerank.end');
    });

    it('skips reranker when rerank: false', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'test')]);
      const reranker = new MockReranker();
      const rerankerSpy = vi.spyOn(reranker, 'rerank');

      const pipeline = new RAGPipeline(embeddingRouter, store, reranker, bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], rerank: false },
        CONTEXT,
      );

      expect(rerankerSpy).not.toHaveBeenCalled();
      expect(result.reranked).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-collection
  // ─────────────────────────────────────────────────────────────────────────

  describe('multi-collection', () => {
    it('searches multiple collections and merges results', async () => {
      const COLL_B = 'test-docs-b';
      await store.createCollection(COLL_B, COLLECTION_CONFIG);

      await store.upsert(COLLECTION, [makeDoc('from-a', [1, 0, 0], 'doc from collection a')]);
      await store.upsert(COLL_B, [makeDoc('from-b', [1, 0, 0], 'doc from collection b')]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION, COLL_B] },
        CONTEXT,
      );

      const ids = result.passages.map((p) => p.id);
      expect(ids).toContain('from-a');
      expect(ids).toContain('from-b');
    });

    it('deduplicates a passage present in multiple collections', async () => {
      const COLL_B = 'test-docs-b';
      await store.createCollection(COLL_B, COLLECTION_CONFIG);

      // Same document ID in both collections
      await store.upsert(COLLECTION, [makeDoc('shared', [1, 0, 0], 'shared doc')]);
      await store.upsert(COLL_B, [makeDoc('shared', [1, 0, 0], 'shared doc')]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search(
        { query: 'shared', collections: [COLLECTION, COLL_B] },
        CONTEXT,
      );

      const ids = result.passages.map((p) => p.id);
      expect(ids.filter((id) => id === 'shared')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Filters (propagated from RAGQuery to VectorStore)
  // ─────────────────────────────────────────────────────────────────────────

  describe('filter propagation', () => {
    it('applies tenantId filter', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('t1', [1, 0, 0], 'tenant a doc', { tenantId: 'tenant-a' }),
        makeDoc('t2', [1, 0, 0], 'tenant b doc', { tenantId: 'tenant-b' }),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const result = await pipeline.search(
        { query: 'test', collections: [COLLECTION], filters: { tenantId: 'tenant-a' } },
        CONTEXT,
      );

      expect(result.passages.every((p) => p.metadata.tenantId === 'tenant-a')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // formatForContext()
  // ─────────────────────────────────────────────────────────────────────────

  describe('formatForContext()', () => {
    let passages: Passage[];

    beforeEach(() => {
      passages = [
        {
          id: 'p1',
          content: 'Hello world',
          score: 0.9,
          metadata: { documentId: 'p1', title: 'Greeting', source: 'https://example.com' },
          collection: COLLECTION,
        },
        {
          id: 'p2',
          content: 'Foo bar baz',
          score: 0.5,
          metadata: { documentId: 'p2', title: 'Other' },
          collection: COLLECTION,
        },
      ];
    });

    it('joins passages with default separator', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages);
      expect(output).toContain('\n---\n');
    });

    it('uses custom separator', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages, { separator: '\n===\n' });
      expect(output).toContain('\n===\n');
      expect(output).not.toContain('\n---\n');
    });

    it('includes source by default', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages);
      expect(output).toContain('Source:');
    });

    it('omits source when includeSource is false', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages, { includeSource: false });
      expect(output).not.toContain('Source:');
    });

    it('includes score when includeScore is true', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages, { includeScore: true });
      expect(output).toContain('Score:');
    });

    it('truncates content to maxCharsPerPassage', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext(passages, {
        maxCharsPerPassage: 5,
        includeSource: false,
      });
      expect(output).toContain('Hello'); // first 5 chars of 'Hello world'
      expect(output).not.toContain('world');
    });

    it('applies custom template with {{content}} and {{source}} placeholders', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const output = pipeline.formatForContext([passages[0]!], {
        template: 'CONTENT: {{content}} | SRC: {{source}}',
      });
      expect(output).toBe('CONTENT: Hello world | SRC: https://example.com');
    });

    it('returns empty string for empty passages array', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      expect(pipeline.formatForContext([])).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAGTool factory
  // ─────────────────────────────────────────────────────────────────────────

  describe('createRAGTool()', () => {
    it('returns a Tool with name "rag.search"', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline);
      expect(tool.name).toBe('rag.search');
    });

    it('execute() returns success with context, sourcesCount, sources', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'quarterly earnings report', {
          title: 'Q1 Report',
          source: 'https://corp.com/q1',
        }),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline, [COLLECTION]);

      const result = await tool.execute({ query: 'earnings' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(typeof result.data.context).toBe('string');
      expect(typeof result.data.sourcesCount).toBe('number');
      expect(Array.isArray(result.data.sources)).toBe(true);
    });

    it('execute() injects tenantId from ExecutionContext into filters', async () => {
      // Only upload docs for tenant-1; a tenant-2 doc should not appear
      await store.upsert(COLLECTION, [
        makeDoc('t1', [1, 0, 0], 'tenant one doc', { tenantId: 'tenant-1' }),
        makeDoc('t2', [1, 0, 0], 'tenant two doc', { tenantId: 'tenant-2' }),
      ]);

      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline, [COLLECTION]);

      // CONTEXT.tenantId = 'tenant-1'
      const result = await tool.execute({ query: 'doc' }, CONTEXT);
      expect(result.success).toBe(true);

      const sources = result.data.sources as Array<{
        title?: string;
        source?: string;
        score: string;
      }>;
      // Tenant-2 doc must not appear
      const resultPassages = result.data.sourcesCount as number;
      expect(resultPassages).toBe(1);
      void sources;
    });

    it('execute() returns success: false on pipeline error', async () => {
      // Search on a non-existent collection should throw → tool catches it
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline, ['nonexistent-collection']);

      const result = await tool.execute({ query: 'test' }, CONTEXT);
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    });

    it('has tags ["rag", "knowledge", "read-only"]', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline);
      expect(tool.tags).toEqual(['rag', 'knowledge', 'read-only']);
    });

    it('has timeout: 60000', () => {
      const pipeline = new RAGPipeline(embeddingRouter, store, undefined, bus, tokens);
      const tool = createRAGTool(pipeline);
      expect(tool.timeout).toBe(60_000);
    });
  });
});
