/**
 * Runs the vector store contract (tests/fixtures/vectorStoreContract.ts) against
 * real engines. Each adapter is tested only when its environment variable is
 * set, so the file is safe to include in any integration run.
 *
 * Start every engine with:
 *
 *   docker compose -f tests/integration/vectorstores.compose.yml up -d
 *   npm run test:vectorstores
 *
 * Variables (the npm script sets them for the compose file):
 *   PGVECTOR_URL      postgres://agent349:agent349@localhost:5433/agent349
 *   QDRANT_URL        http://localhost:6333
 *   WEAVIATE_URL      http://localhost:8089
 *   MILVUS_URL        http://localhost:19530
 *   PINECONE_URL      http://localhost:5080  (Pinecone Local control plane)
 *   MEILI_URL         http://localhost:7701  (with MEILI_API_KEY)
 */
import { describe, it } from 'vitest';
import { describeVectorStoreContract } from '../fixtures/vectorStoreContract.js';
import { PgVectorAdapter } from '../../src/rag/vectorstore/PgVectorAdapter.js';
import { MeilisearchAdapter } from '../../src/rag/vectorstore/MeilisearchAdapter.js';
import { QdrantAdapter } from '../../src/rag/vectorstore/QdrantAdapter.js';
import { WeaviateAdapter } from '../../src/rag/vectorstore/WeaviateAdapter.js';
import { MilvusAdapter } from '../../src/rag/vectorstore/MilvusAdapter.js';
import { PineconeAdapter } from '../../src/rag/vectorstore/PineconeAdapter.js';

const env = process.env;

if (env['PGVECTOR_URL']) {
  describeVectorStoreContract(
    'PgVectorAdapter',
    () =>
      new PgVectorAdapter({ connectionString: env['PGVECTOR_URL']!, textSearchConfig: 'simple' }),
    { keyword: true, metadataFilter: true },
  );
}

if (env['QDRANT_URL']) {
  describeVectorStoreContract(
    'QdrantAdapter',
    () => new QdrantAdapter({ url: env['QDRANT_URL']!, apiKey: env['QDRANT_API_KEY'] }),
    { keyword: true, metadataFilter: true },
  );
}

if (env['WEAVIATE_URL']) {
  describeVectorStoreContract(
    'WeaviateAdapter',
    () => new WeaviateAdapter({ url: env['WEAVIATE_URL']! }),
    // Custom metadata is stored but not filterable in Weaviate.
    { keyword: true, metadataFilter: false },
  );
}

if (env['MILVUS_URL']) {
  describeVectorStoreContract(
    'MilvusAdapter',
    () => new MilvusAdapter({ url: env['MILVUS_URL']! }),
    { keyword: true, metadataFilter: true },
  );
}

if (env['PINECONE_URL']) {
  describeVectorStoreContract(
    'PineconeAdapter',
    () =>
      new PineconeAdapter({
        controlPlaneUrl: env['PINECONE_URL']!,
        apiKey: env['PINECONE_API_KEY'] ?? 'pclocal',
        indexName: `agent349-contract-${process.pid}`,
        createIndex: { cloud: 'aws', region: 'us-east-1' },
      }),
    // Dense Pinecone indexes rank by vector only; custom metadata is not filterable.
    { keyword: false, metadataFilter: false },
  );
}

if (env['MEILI_URL']) {
  describeVectorStoreContract(
    'MeilisearchAdapter',
    () =>
      new MeilisearchAdapter({
        url: env['MEILI_URL']!,
        ...(env['MEILI_API_KEY'] !== undefined && { apiKey: env['MEILI_API_KEY'] }),
      }),
    // Meilisearch does not evaluate filter.metadata.
    { keyword: true, metadataFilter: false },
  );
}

describe('vector store engines', () => {
  it('has at least one engine configured, or is skipped', () => {
    // Keeps the file valid when no engine variables are set.
  });
});
