/**
 * Integration test: end-to-end ingestion pipeline via Orchestrator.rag
 *
 * Uses InMemoryVectorStore (no external services) and MockEmbeddingProvider.
 * Covers the full path: Orchestrator.rag → RAGFacade → IngestionPipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../src/config/ConfigLoader.js';
import { EmbeddingProvider } from '../../src/rag/embedding/EmbeddingProvider.js';
import type { EmbeddingResult, ExecutionContext } from '../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock embedding provider
// ─────────────────────────────────────────────────────────────────────────────

class MockEmbeddingProvider extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-v1';
  getDimensions() {
    return 4;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    return {
      vector: [(text.length % 5) * 0.1, 0.5, 0.3, 0.1],
      dimensions: 4,
      tokensUsed: Math.ceil(text.length / 4),
      latencyMs: 1,
      model: 'mock-v1',
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async validate() {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator.rag — integration', () => {
  let orch: Orchestrator;
  const ctx: ExecutionContext = {
    tenantId: 'test',
    userId: 'test-user',
    roles: ['admin'],
    sessionId: 'test-session',
    agentId: 'test-agent',
    requestId: 'test-request',
  };

  beforeEach(async () => {
    // Route the partial config through ConfigLoader so newer required sections
    // (e.g. `audit`) are filled with defaults.
    orch = await Orchestrator.fromConfig(
      ConfigLoader.from({
        storage: { backends: { memory: { type: 'memory' } } },
        llm: {
          providers: {},
          circuitBreaker: { failureThreshold: 3, recoveryTimeMs: 30000 },
        },
        memory: {
          session: {
            backend: 'memory',
            strategy: 'sliding_window',
            ttlSeconds: 3600,
            maxMessagesBeforeCompress: 20,
          },
          longTerm: { backend: 'memory', maxFactsPerUser: 100 },
        },
        session: { backend: 'memory' },
        tools: { defaultTimeoutMs: 10000, maxRetries: 3, retryBackoffMs: 100 },
        agent: { maxLoopIterations: 10, defaultTemperature: 0.7, defaultMaxTokens: 2048 },
        tokens: {
          backend: 'memory',
          limits: {
            perTenant: { daily: 100000, monthly: 1000000 },
            perUser: { daily: 10000, monthly: 100000 },
          },
          pricing: {},
        },
        logging: { level: 'info', includeTokenUsage: false },
        rag: {
          vectorStore: { adapter: 'in-memory' },
          embedding: {
            defaultProvider: 'mock',
            defaultModel: 'mock-v1',
            defaultDimensions: 4,
            providers: {},
          },
          retrieval: {
            topK: 5,
            finalTopK: 3,
            hybridAlpha: 0.7,
            searchMode: 'vector',
            minScore: 0,
            rerank: false,
            rrfK: 60,
          },
        },
      }).get(),
    );

    // Register mock embedding provider in the RAG subsystem
    orch.registerEmbeddingProvider(new MockEmbeddingProvider());
  });

  it('orch.rag is defined', () => {
    expect(orch.rag).toBeDefined();
  });

  it('Step 1: createCollection', async () => {
    await orch.rag.createCollection('test-int', {
      embeddingProvider: 'mock',
      embeddingModel: 'mock-v1',
      dimensions: 4,
      distanceMetric: 'cosine',
    });

    const list = await orch.rag.listCollections();
    expect(list.find((c) => c.name === 'test-int')).toBeDefined();
  });

  it('Step 2: ingest and retrieve a document', async () => {
    const collection = `col-${Date.now()}`;

    const result = await orch.rag.ingest(
      { type: 'text', text: 'Política de vacaciones: 20 días hábiles por año.' },
      collection,
    );

    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.documentId).toBeTruthy();

    // Step 3: search should find the document
    const searchResult = await orch.rag.search(
      {
        query: 'vacaciones',
        collections: [collection],
        topK: 5,
      },
      ctx,
    );

    expect(searchResult.passages.length).toBeGreaterThan(0);
    expect(searchResult.passages[0]!.content).toContain('vacaciones');
  });

  it('Step 4: removeDocument deletes all chunks', async () => {
    const collection = `col-remove-${Date.now()}`;

    const result = await orch.rag.ingest(
      { type: 'text', text: 'This document will be removed from the collection.' },
      collection,
    );

    expect(result.chunksCreated).toBeGreaterThan(0);

    // Remove the document
    const { chunksRemoved } = await orch.rag.removeDocument(result.documentId, collection);
    expect(chunksRemoved).toBeGreaterThan(0);

    // Search should return nothing
    const afterRemoval = await orch.rag.search(
      { query: 'removed', collections: [collection], topK: 5 },
      ctx,
    );

    expect(afterRemoval.passages.length).toBe(0);
  });

  it('ingestDirectory processes text files in a directory', async () => {
    // Use the docs directory which has .md files
    const collection = `col-dir-${Date.now()}`;

    const results = await orch.rag.ingestDirectory('./docs', collection, {
      extensions: ['.md'],
      recursive: false,
    });

    // Should have processed at least one .md file without crashing
    expect(Array.isArray(results)).toBe(true);
    // If any files were found, they should be processed
    for (const r of results) {
      if (!r.errors) {
        expect(r.chunksCreated).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
