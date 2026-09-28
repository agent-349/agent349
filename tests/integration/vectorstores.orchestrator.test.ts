/**
 * End-to-end RAG through the Orchestrator for each database-backed vector
 * store: JSON-shaped config → ingestion (chunking + embeddings) → scoped search
 * → shutdown. Runs for each engine whose variable is set (see
 * vectorstores.test.ts for the list and the compose file).
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../src/core/Orchestrator.js';
import { EmbeddingProvider } from '../../src/rag/embedding/EmbeddingProvider.js';
import type { EmbeddingResult, ProviderProbe } from '../../src/types/index.js';
import { tokenize } from '../../src/rag/vectorstore/common.js';

const DIMS = 16;

/** Deterministic bag-of-words embedder: similar wording gives similar vectors. */
class HashingEmbedder extends EmbeddingProvider {
  readonly name = 'hashing';
  readonly model = 'hashing-16';

  async embed(text: string): Promise<EmbeddingResult> {
    const vector = new Array<number>(DIMS).fill(0);
    for (const token of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
      vector[h % DIMS]! += 1;
    }
    if (vector.every((v) => v === 0)) vector[0] = 1;
    return { vector, model: this.model, dimensions: DIMS, tokensUsed: 0, latencyMs: 0 };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  getDimensions(): number {
    return DIMS;
  }

  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }
}

const env = process.env;
const engines: { name: string; vectorStore: Record<string, unknown>; vectorOnly?: boolean }[] = [];
if (env['PGVECTOR_URL']) {
  engines.push({
    name: 'pgvector',
    vectorStore: { adapter: 'pgvector', pgvector: { connectionString: env['PGVECTOR_URL'] } },
  });
}
if (env['QDRANT_URL']) {
  engines.push({
    name: 'qdrant',
    vectorStore: { adapter: 'qdrant', qdrant: { url: env['QDRANT_URL'] } },
  });
}
if (env['WEAVIATE_URL']) {
  engines.push({
    name: 'weaviate',
    vectorStore: { adapter: 'weaviate', weaviate: { url: env['WEAVIATE_URL'] } },
  });
}
if (env['MILVUS_URL']) {
  engines.push({
    name: 'milvus',
    vectorStore: { adapter: 'milvus', milvus: { url: env['MILVUS_URL'] } },
  });
}
if (env['PINECONE_URL']) {
  engines.push({
    name: 'pinecone',
    vectorOnly: true,
    vectorStore: {
      adapter: 'pinecone',
      pinecone: {
        controlPlaneUrl: env['PINECONE_URL'],
        apiKey: 'pclocal',
        indexName: `agent349-e2e-${process.pid}`,
        createIndex: { cloud: 'aws', region: 'us-east-1' },
      },
    },
  });
}

describe.each(engines)('RAG end to end on $name', ({ vectorStore, vectorOnly }) => {
  it('ingests, searches with tenant and role scope, and shuts down', async () => {
    const orch = await Orchestrator.create({
      rag: {
        vectorStore: vectorStore as never,
        embedding: {
          defaultProvider: 'hashing',
          defaultModel: 'hashing-16',
          defaultDimensions: DIMS,
        },
        retrieval: { searchMode: vectorOnly === true ? 'vector' : 'hybrid', rerank: false },
      },
    });
    orch.registerEmbeddingProvider(new HashingEmbedder());
    const collection = `e2e_${Date.now().toString(36)}`;
    try {
      await orch.rag.createCollection(collection, {
        embeddingProvider: 'hashing',
        embeddingModel: 'hashing/hashing-16',
        dimensions: DIMS,
        distanceMetric: 'cosine',
      });
      await orch.rag.ingest(
        { type: 'text', text: 'Employees may work remotely three days per week.' },
        collection,
        {
          metadata: { documentId: 'remote-policy', tenantId: 'acme', accessRoles: [] },
        },
      );
      await orch.rag.ingest(
        { type: 'text', text: 'Salary bands for engineering levels one to five.' },
        collection,
        {
          metadata: { documentId: 'salary-bands', tenantId: 'acme', accessRoles: ['hr_admin'] },
        },
      );
      await orch.rag.ingest(
        { type: 'text', text: 'Employees may work remotely every day at globex.' },
        collection,
        {
          metadata: { documentId: 'globex-policy', tenantId: 'globex', accessRoles: [] },
        },
      );

      const context = {
        tenantId: 'acme',
        userId: 'ana',
        roles: ['employee'],
        agentId: 'test',
        sessionId: 's',
        requestId: 'r',
      };
      const result = await orch.rag.search(
        {
          query: 'can employees work remotely',
          collections: [collection],
          topK: 5,
          finalTopK: 5,
          searchMode: vectorOnly === true ? 'vector' : 'hybrid',
          filters: { tenantId: 'acme', accessRoles: ['employee'] },
        },
        context,
      );
      const docs = result.passages.map((p) => p.metadata.documentId);
      expect(docs[0]).toBe('remote-policy');
      expect(docs).not.toContain('salary-bands'); // restricted role
      expect(docs).not.toContain('globex-policy'); // other tenant

      expect(
        (
          await orch.rag.pipeline.search(
            {
              query: 'salary',
              collections: [collection],
              searchMode: vectorOnly === true ? 'vector' : 'keyword',
              filters: { tenantId: 'acme', accessRoles: ['hr_admin'] },
            },
            context,
          )
        ).passages.map((p) => p.metadata.documentId),
      ).toContain('salary-bands');
    } finally {
      await orch.rag.deleteCollection(collection);
      await orch.shutdown();
    }
  }, 120_000);
});

describe('vector store engines (orchestrator)', () => {
  it('runs only for configured engines', () => {
    expect(Array.isArray(engines)).toBe(true);
  });
});
