import type { VectorStoreAdapter } from './VectorStoreAdapter.js';
import { InMemoryVectorStore } from './InMemoryVectorStore.js';
import { MeilisearchAdapter } from './MeilisearchAdapter.js';
import type { MeilisearchConfig } from './MeilisearchAdapter.js';
import { PgVectorAdapter } from './PgVectorAdapter.js';
import type { PgVectorConfig } from './PgVectorAdapter.js';
import { QdrantAdapter } from './QdrantAdapter.js';
import type { QdrantConfig } from './QdrantAdapter.js';
import { PineconeAdapter } from './PineconeAdapter.js';
import type { PineconeConfig } from './PineconeAdapter.js';
import { WeaviateAdapter } from './WeaviateAdapter.js';
import type { WeaviateConfig } from './WeaviateAdapter.js';
import { MilvusAdapter } from './MilvusAdapter.js';
import type { MilvusConfig } from './MilvusAdapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Vector store factory
// ─────────────────────────────────────────────────────────────────────────────

/** Union of all known vector store adapter configs. */
export type VectorStoreAdapterConfig =
  | { adapter: 'in-memory' }
  | { adapter: 'meilisearch'; config?: MeilisearchConfig }
  | { adapter: 'pgvector'; config?: PgVectorConfig }
  | { adapter: 'qdrant'; config?: QdrantConfig }
  | { adapter: 'pinecone'; config: PineconeConfig }
  | { adapter: 'weaviate'; config?: WeaviateConfig }
  | { adapter: 'milvus'; config?: MilvusConfig };

/** Names of the built-in vector store adapters. */
export type VectorStoreAdapterName = VectorStoreAdapterConfig['adapter'];

/**
 * Creates the appropriate {@link VectorStoreAdapter} from a configuration object.
 *
 * @example
 * ```typescript
 * const store = createVectorStoreAdapter({ adapter: 'qdrant', config: { url: 'http://localhost:6333' } });
 * ```
 *
 * @param config - Adapter selection and its configuration.
 * @returns A concrete vector store adapter instance.
 */
export function createVectorStoreAdapter(config: VectorStoreAdapterConfig): VectorStoreAdapter {
  switch (config.adapter) {
    case 'meilisearch':
      return new MeilisearchAdapter(config.config);
    case 'pgvector':
      return new PgVectorAdapter(config.config);
    case 'qdrant':
      return new QdrantAdapter(config.config);
    case 'pinecone':
      return new PineconeAdapter(config.config);
    case 'weaviate':
      return new WeaviateAdapter(config.config);
    case 'milvus':
      return new MilvusAdapter(config.config);
    case 'in-memory':
    default:
      return new InMemoryVectorStore();
  }
}
