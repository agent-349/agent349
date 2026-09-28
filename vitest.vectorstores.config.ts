import { defineConfig } from 'vitest/config';

// Contract and end-to-end tests against the engines started by
// tests/integration/vectorstores.compose.yml. Variables already set in the
// environment win, so the same suite can target other instances.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/vectorstores*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      PGVECTOR_URL:
        process.env['PGVECTOR_URL'] ?? 'postgres://agent349:agent349@localhost:5433/agent349',
      QDRANT_URL: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
      WEAVIATE_URL: process.env['WEAVIATE_URL'] ?? 'http://localhost:8089',
      MILVUS_URL: process.env['MILVUS_URL'] ?? 'http://localhost:19530',
      PINECONE_URL: process.env['PINECONE_URL'] ?? 'http://localhost:5080',
      MEILI_URL: process.env['MEILI_URL'] ?? 'http://localhost:7701',
      MEILI_API_KEY: process.env['MEILI_API_KEY'] ?? 'agent349-test-key',
    },
  },
});
