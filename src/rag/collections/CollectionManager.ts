import type { CollectionConfig } from '../../types/index.js';
import type { VectorStoreAdapter } from '../vectorstore/VectorStoreAdapter.js';
import type { CollectionSummary } from '../ingestion/types.js';
import { SDKError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// CollectionManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages vector store collections: creation, listing, inspection, and deletion.
 *
 * Wraps the low-level {@link VectorStoreAdapter} API and maintains additional
 * metadata (embedding provider, creation timestamps, document counts) that the
 * vector store does not always expose natively.
 *
 * @example
 * ```typescript
 * const manager = new CollectionManager(vectorStore);
 * await manager.create('policies', {
 *   embeddingProvider: 'openai',
 *   embeddingModel: 'text-embedding-3-small',
 *   dimensions: 1536,
 *   distanceMetric: 'cosine',
 * });
 * const list = await manager.list();
 * ```
 */
export class CollectionManager {
  readonly #store: VectorStoreAdapter;

  /** Locally tracked collection metadata, keyed by collection name. */
  readonly #metadata = new Map<string, CollectionMeta>();

  constructor(vectorStore: VectorStoreAdapter) {
    this.#store = vectorStore;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new collection.
   *
   * Behaviour when the collection already exists depends on the underlying
   * adapter (some overwrite, others throw).
   *
   * @param name   - Collection name.
   * @param config - Collection configuration.
   */
  async create(name: string, config: CollectionConfig): Promise<void> {
    await this.#store.createCollection(name, config);
    this.#metadata.set(name, {
      config,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      chunkCount: 0,
      documentCount: 0,
    });
  }

  /**
   * Returns summary information for all known collections.
   *
   * Collections created outside this manager instance (e.g. by the
   * {@link IngestionPipeline}) will not appear here unless they were
   * registered via `create()`.
   */
  async list(): Promise<CollectionSummary[]> {
    const summaries: CollectionSummary[] = [];

    for (const [name, meta] of this.#metadata) {
      try {
        const info = await this.#store.collectionInfo(name);
        summaries.push({
          name,
          documentCount: meta.documentCount,
          chunkCount: info.documentCount, // vector store counts chunks
          dimensions: info.dimensions,
          embeddingProvider: meta.config.embeddingProvider,
          embeddingModel: meta.config.embeddingModel,
          distanceMetric: info.distanceMetric,
          createdAt: meta.createdAt,
          lastUpdatedAt: meta.lastUpdatedAt,
        });
      } catch {
        // Collection may have been deleted externally — skip
      }
    }

    return summaries;
  }

  /**
   * Returns summary information for a single collection.
   *
   * @param name - Collection name.
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection
   *                          is not tracked by this manager.
   */
  async info(name: string): Promise<CollectionSummary> {
    const meta = this.#metadata.get(name);
    if (!meta) {
      throw new SDKError(
        `Collection '${name}' is not managed by this CollectionManager`,
        'COLLECTION_NOT_FOUND',
      );
    }

    const storeInfo = await this.#store.collectionInfo(name);

    return {
      name,
      documentCount: meta.documentCount,
      chunkCount: storeInfo.documentCount,
      dimensions: storeInfo.dimensions,
      embeddingProvider: meta.config.embeddingProvider,
      embeddingModel: meta.config.embeddingModel,
      distanceMetric: storeInfo.distanceMetric,
      createdAt: meta.createdAt,
      lastUpdatedAt: meta.lastUpdatedAt,
    };
  }

  /**
   * Deletes a collection and all its data from the underlying store, then
   * removes it from the local registry. Deleting a collection that does not
   * exist in the store is a no-op (the registry entry is still cleared).
   *
   * @param name - Collection to delete.
   */
  async delete(name: string): Promise<void> {
    await this.#store.deleteCollection(name);
    this.#metadata.delete(name);
  }

  /**
   * Checks that the underlying vector store is reachable and operational.
   * Delegates to {@link VectorStoreAdapter.healthCheck}.
   */
  async healthCheck(): Promise<boolean> {
    return this.#store.healthCheck();
  }

  /**
   * Returns `true` if the collection exists in the underlying store.
   *
   * @param name - Collection name to check.
   */
  async exists(name: string): Promise<boolean> {
    return this.#store.collectionExists(name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal bookkeeping (called by IngestionPipeline integration)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a collection that was auto-created by the ingestion pipeline.
   * Called internally by {@link RAGFacade}.
   */
  registerExternal(name: string, config: CollectionConfig): void {
    if (!this.#metadata.has(name)) {
      this.#metadata.set(name, {
        config,
        createdAt: new Date(),
        lastUpdatedAt: new Date(),
        chunkCount: 0,
        documentCount: 0,
      });
    }
  }

  /**
   * Updates document and chunk counters after an ingestion.
   */
  recordIngest(name: string, chunksAdded: number): void {
    const meta = this.#metadata.get(name);
    if (meta) {
      meta.documentCount += 1;
      meta.chunkCount += chunksAdded;
      meta.lastUpdatedAt = new Date();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface CollectionMeta {
  config: CollectionConfig;
  createdAt: Date;
  lastUpdatedAt: Date;
  chunkCount: number;
  documentCount: number;
}
