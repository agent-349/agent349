import type {
  Passage,
  RAGFilter,
  CollectionInfo,
  CollectionConfig,
  VectorDocument,
  DocumentMetadata,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// VectorStoreAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all vector store adapters in the RAG module.
 *
 * Concrete adapters translate the SDK's normalised search interface to and
 * from the storage engine's native wire format:
 *
 * | Engine      | Class                 | Keyword search                 | Hybrid search                 |
 * |-------------|-----------------------|--------------------------------|-------------------------------|
 * | In-Memory   | `InMemoryVectorStore` | Token overlap (for testing)    | RRF                           |
 * | Meilisearch | `MeilisearchAdapter`  | Native full-text               | Native (`semanticRatio`)      |
 * | pgvector    | `PgVectorAdapter`     | PostgreSQL full-text search    | RRF                           |
 * | Qdrant      | `QdrantAdapter`       | BM25 sparse vectors (IDF)      | RRF                           |
 * | Weaviate    | `WeaviateAdapter`     | Native BM25                    | Native (`alpha`)              |
 * | Milvus      | `MilvusAdapter`       | Native BM25 function           | RRF                           |
 * | Pinecone    | `PineconeAdapter`     | Not supported                  | Not supported                 |
 *
 * **Critical consistency rules:**
 * - Every collection must use a single, consistent embedding model.
 * - The `alpha` parameter in `hybridSearch` controls the vector/keyword
 *   weighting: `0` = pure keyword, `1` = pure vector.
 *
 * @example
 * ```typescript
 * class MyAdapter extends VectorStoreAdapter {
 *   readonly name = 'my-db';
 *   async search(collection, vector, topK, filter?) { ... }
 *   // ...implement all abstract methods
 * }
 * ```
 */
export abstract class VectorStoreAdapter {
  /** Human-readable adapter identifier (e.g. `'in-memory'`, `'qdrant'`). */
  abstract readonly name: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Performs a dense vector (semantic) similarity search.
   *
   * Results are sorted by similarity score descending (highest first) and
   * limited to `topK` entries. Scores are normalised to [0, 1].
   *
   * @param collection - Collection to search.
   * @param vector     - Query embedding vector.
   * @param topK       - Maximum number of results to return.
   * @param filter     - Optional metadata filter to narrow candidates.
   * @returns Passages sorted by descending similarity score.
   */
  abstract search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]>;

  /**
   * Performs a full-text keyword search over document content.
   *
   * Scoring semantics depend on the adapter (BM25, TF-IDF, simple overlap,
   * etc.). Results are sorted by score descending and limited to `topK`.
   * Scores are normalised to [0, 1].
   *
   * @param collection - Collection to search.
   * @param query      - Raw query string for full-text matching.
   * @param topK       - Maximum number of results to return.
   * @param filter     - Optional metadata filter to narrow candidates.
   * @returns Passages sorted by descending keyword relevance score.
   */
  abstract keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]>;

  /**
   * Performs a hybrid search combining vector similarity and keyword matching.
   *
   * The `alpha` parameter controls the balance between the two signals:
   * - `alpha = 1.0` → pure vector search
   * - `alpha = 0.0` → pure keyword search
   * - `alpha = 0.7` → recommended default (70 % vector, 30 % keyword)
   *
   * Adapters that natively support hybrid search use their built-in fusion
   * mechanism. Adapters that do not may delegate to `search()` +
   * `keywordSearch()` and apply {@link reciprocalRankFusion} as a fallback.
   *
   * @param collection - Collection to search.
   * @param vector     - Query embedding vector.
   * @param query      - Raw query string for keyword matching.
   * @param topK       - Maximum number of results to return.
   * @param alpha      - Weighting factor for vector vs keyword (0–1).
   * @param filter     - Optional metadata filter to narrow candidates.
   * @returns Merged, deduplicated passages sorted by combined score.
   */
  abstract hybridSearch(
    collection: string,
    vector: number[],
    query: string,
    topK: number,
    alpha: number,
    filter?: RAGFilter,
    rrfK?: number,
  ): Promise<Passage[]>;

  /**
   * Returns `true` if the named collection exists in this store.
   *
   * @param collection - Collection name to check.
   */
  abstract collectionExists(collection: string): Promise<boolean>;

  /**
   * Returns metadata for the named collection.
   *
   * @param collection - Collection name to look up.
   * @throws When the collection does not exist.
   */
  abstract collectionInfo(collection: string): Promise<CollectionInfo>;

  /**
   * Checks that the adapter can connect to the underlying storage engine.
   *
   * @returns `true` if the store is reachable and operational, `false` otherwise.
   */
  abstract healthCheck(): Promise<boolean>;

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion API (prepared for future implementation)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inserts or updates documents in the named collection.
   *
   * Upserting a document whose `id` already exists replaces it atomically.
   * All vectors in `documents` must have a dimensionality that matches the
   * collection's configured `dimensions`.
   *
   * @param collection - Target collection.
   * @param documents  - Documents to upsert.
   * @throws When the collection does not exist.
   */
  abstract upsert(collection: string, documents: VectorDocument[]): Promise<void>;

  /**
   * Removes documents by their IDs from the named collection.
   *
   * Silently ignores IDs that do not exist in the collection.
   *
   * @param collection - Target collection.
   * @param ids        - Document IDs to delete.
   * @throws When the collection does not exist.
   */
  abstract delete(collection: string, ids: string[]): Promise<void>;

  /**
   * Creates a new collection with the given configuration.
   *
   * Behaviour when the collection already exists is implementation-defined
   * (some adapters overwrite, others throw).
   *
   * @param collection - Name of the new collection.
   * @param config     - Collection configuration (dimensions, distance metric, model).
   */
  abstract createCollection(collection: string, config: CollectionConfig): Promise<void>;

  /**
   * Deletes a collection and ALL of its data from the underlying store.
   *
   * Deleting a collection that does not exist is a no-op (adapters must not throw).
   *
   * @param collection - Collection to delete.
   */
  abstract deleteCollection(collection: string): Promise<void>;

  /**
   * Removes every document (chunk) matching the filter from the collection.
   *
   * An empty filter (no active fields) must be rejected with an error — a
   * caller that wants to wipe a collection should use {@link deleteCollection}
   * instead. This guards against accidental mass deletion.
   *
   * @param collection - Target collection.
   * @param filter     - Filter selecting the documents to remove (must be non-empty).
   * @returns Number of chunks removed (best effort; `-1` when the engine does not report it).
   */
  abstract removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }>;

  /**
   * Updates metadata fields on every document (chunk) matching the filter,
   * WITHOUT touching content or embeddings — no re-embedding takes place.
   *
   * Typical use: re-stamping `accessRoles` after a permission change, or
   * rewriting `tags` after a re-categorisation.
   *
   * Only metadata fields are patchable (`accessRoles`, `tags`, `language`,
   * `author`, `title`, `source`); adapters ignore unknown fields. `updatedAt`
   * is set automatically. An empty filter is rejected (same rule as
   * {@link removeDocumentsByFilter}).
   *
   * @param collection - Target collection.
   * @param filter     - Filter selecting the documents to update (must be non-empty).
   * @param patch      - Metadata fields to set on the matched documents.
   * @returns Number of chunks updated.
   */
  abstract updateDocumentsMetadata(
    collection: string,
    filter: RAGFilter,
    patch: Partial<DocumentMetadata>,
  ): Promise<{ updated: number }>;

  /**
   * Lists the distinct source-document IDs (`metadata.documentId`) present in
   * the collection. Used for consistency checks and orphan purging against an
   * external source of truth.
   *
   * @param collection - Collection to inspect.
   * @returns Distinct document IDs (unordered).
   */
  abstract listDocumentIds(collection: string): Promise<string[]>;

  /**
   * Releases resources the adapter owns (connection pools, clients). Called by
   * `Orchestrator.shutdown()`. The default implementation does nothing;
   * adapters holding connections override it. Resources injected by the host
   * are never closed.
   */
  async close(): Promise<void> {
    // No owned resources by default.
  }
}
