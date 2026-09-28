import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigLoader } from '../../../../src/config/ConfigLoader.js';
import { Orchestrator } from '../../../../src/core/Orchestrator.js';
import { ConfigError } from '../../../../src/errors/index.js';
import { InMemoryVectorStore } from '../../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { PgVectorAdapter } from '../../../../src/rag/vectorstore/PgVectorAdapter.js';
import { QdrantAdapter } from '../../../../src/rag/vectorstore/QdrantAdapter.js';
import { PineconeAdapter } from '../../../../src/rag/vectorstore/PineconeAdapter.js';
import { WeaviateAdapter } from '../../../../src/rag/vectorstore/WeaviateAdapter.js';
import { MilvusAdapter } from '../../../../src/rag/vectorstore/MilvusAdapter.js';
import { MeilisearchAdapter } from '../../../../src/rag/vectorstore/MeilisearchAdapter.js';
import { createVectorStoreAdapter } from '../../../../src/rag/vectorstore/createVectorStoreAdapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rag.vectorStore configuration', () => {
  const load = (vectorStore: Record<string, unknown>, retrieval: Record<string, unknown> = {}) =>
    ConfigLoader.from({ rag: { vectorStore: vectorStore as never, retrieval } }).get();

  it('accepts every built-in adapter with its settings', () => {
    expect(() =>
      load({ adapter: 'pgvector', pgvector: { connectionString: 'postgres://x' } }),
    ).not.toThrow();
    expect(() => load({ adapter: 'qdrant' })).not.toThrow();
    expect(() => load({ adapter: 'weaviate', weaviate: { url: 'http://w' } })).not.toThrow();
    expect(() => load({ adapter: 'milvus', milvus: { url: 'http://m' } })).not.toThrow();
    expect(() =>
      load({ adapter: 'pinecone', pinecone: { indexName: 'kb' } }, { searchMode: 'vector' }),
    ).not.toThrow();
  });

  it('rejects unknown adapters and missing required settings', () => {
    expect(() => load({ adapter: 'chroma' })).toThrow(/must be one of/);
    expect(() => load({ adapter: 'pgvector' })).toThrow(/connectionString \(or host\)/);
    expect(() => load({ adapter: 'pgvector', pgvector: { connectionString: '' } })).toThrow(
      ConfigError,
    );
    expect(() => load({ adapter: 'pinecone', pinecone: {} }, { searchMode: 'vector' })).toThrow(
      /indexName is required/,
    );
    expect(() => load({ adapter: 'weaviate', weaviate: { classPrefix: 'x_' } })).toThrow(
      /uppercase/,
    );
  });

  it('requires vector search mode for Pinecone', () => {
    expect(() => load({ adapter: 'pinecone', pinecone: { indexName: 'kb' } })).toThrow(
      /Pinecone supports vector search only/,
    );
  });
});

describe('createVectorStoreAdapter', () => {
  it('builds each adapter by name', () => {
    expect(createVectorStoreAdapter({ adapter: 'in-memory' })).toBeInstanceOf(InMemoryVectorStore);
    expect(createVectorStoreAdapter({ adapter: 'meilisearch' })).toBeInstanceOf(MeilisearchAdapter);
    expect(createVectorStoreAdapter({ adapter: 'pgvector' })).toBeInstanceOf(PgVectorAdapter);
    expect(createVectorStoreAdapter({ adapter: 'qdrant' })).toBeInstanceOf(QdrantAdapter);
    expect(
      createVectorStoreAdapter({ adapter: 'pinecone', config: { indexName: 'kb' } }),
    ).toBeInstanceOf(PineconeAdapter);
    expect(createVectorStoreAdapter({ adapter: 'weaviate' })).toBeInstanceOf(WeaviateAdapter);
    expect(createVectorStoreAdapter({ adapter: 'milvus' })).toBeInstanceOf(MilvusAdapter);
  });
});

describe('Orchestrator vector store wiring', () => {
  it('builds the configured adapter and closes it on shutdown', async () => {
    const close = vi.spyOn(PgVectorAdapter.prototype, 'close');
    const exists = vi.spyOn(PgVectorAdapter.prototype, 'collectionExists').mockResolvedValue(true);
    const orch = await Orchestrator.create({
      rag: { vectorStore: { adapter: 'pgvector', pgvector: { connectionString: 'postgres://x' } } },
    });
    await orch.rag.collections.exists('docs');
    expect(exists).toHaveBeenCalledWith('docs');
    await orch.shutdown();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses an injected store and leaves its lifecycle to the host', async () => {
    const store = new InMemoryVectorStore();
    const close = vi.spyOn(store, 'close');
    const orch = await Orchestrator.create(
      { rag: { vectorStore: { adapter: 'qdrant' } } },
      { vectorStore: store },
    );
    await orch.rag.createCollection('docs', {
      dimensions: 3,
      distanceMetric: 'cosine',
      embeddingProvider: 'x',
      embeddingModel: 'x/y',
    });
    expect(await store.collectionExists('docs')).toBe(true);
    await orch.shutdown();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not close a store that was never built', async () => {
    const close = vi.spyOn(PgVectorAdapter.prototype, 'close');
    const orch = await Orchestrator.create({
      rag: { vectorStore: { adapter: 'pgvector', pgvector: { connectionString: 'postgres://x' } } },
    });
    await orch.shutdown();
    expect(close).not.toHaveBeenCalled();
  });
});
