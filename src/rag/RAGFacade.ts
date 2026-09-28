import type { ExecutionContext, CollectionConfig, DocumentMetadata } from '../types/index.js';
import type { RAGQuery, RAGResult, RAGFilter, RerankerValidation } from './types.js';
import type { RAGPipeline } from './RAGPipeline.js';
import type { IngestionPipeline } from './ingestion/IngestionPipeline.js';
import type { CollectionManager } from './collections/CollectionManager.js';
import type {
  DocumentSource,
  IngestOptions,
  IngestResult,
  IngestDirectoryOptions,
  CollectionSummary,
} from './ingestion/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// RAGFacade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simplified RAG API exposed on the Orchestrator.
 *
 * Provides a unified interface for ingestion, collection management, and
 * document search without requiring callers to interact with the low-level
 * {@link IngestionPipeline}, {@link CollectionManager}, or {@link RAGPipeline}
 * directly.
 *
 * ### Quick start
 * ```typescript
 * // Ingest documents
 * await orch.rag.createCollection('policies');
 * await orch.rag.ingest('./docs/policy.pdf', 'policies');
 *
 * // Search (bypasses AgentLoop — use for direct queries)
 * const result = await orch.rag.search({ query: 'vacation policy', collections: ['policies'] }, ctx);
 * ```
 */
/** Default embedding configuration injected from `SDKConfig.rag.embedding`. */
export interface RAGFacadeEmbeddingDefaults {
  /** Default provider name (e.g. `'openai'`). */
  embeddingProvider: string;
  /** Full model string with provider prefix (e.g. `'openai/text-embedding-3-small'`). */
  embeddingModel: string;
  /** Vector dimensions matching the model. */
  dimensions: number;
}

export class RAGFacade {
  readonly #ragPipeline: RAGPipeline;
  readonly #ingestion: IngestionPipeline;
  readonly #collections: CollectionManager;
  readonly #embeddingDefaults: RAGFacadeEmbeddingDefaults;

  constructor(
    ragPipeline: RAGPipeline,
    ingestionPipeline: IngestionPipeline,
    collectionManager: CollectionManager,
    embeddingDefaults?: RAGFacadeEmbeddingDefaults,
  ) {
    this.#ragPipeline = ragPipeline;
    this.#ingestion = ingestionPipeline;
    this.#collections = collectionManager;
    this.#embeddingDefaults = embeddingDefaults ?? {
      embeddingProvider: 'openai',
      embeddingModel: 'openai/text-embedding-3-small',
      dimensions: 1536,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ingests a document into a collection.
   *
   * Accepts either a file path string or a full {@link DocumentSource}.
   *
   * @param source     - File path or document source descriptor.
   * @param collection - Target collection (auto-created if missing).
   * @param options    - Ingestion options.
   */
  async ingest(
    source: string | DocumentSource,
    collection: string,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const resolved: DocumentSource =
      typeof source === 'string' ? { type: 'file', path: source } : source;

    const result = await this.#ingestion.ingest(resolved, collection, options);
    this.#collections.recordIngest(collection, result.chunksCreated);
    return result;
  }

  /**
   * Ingests all supported files in a directory tree.
   *
   * @param path       - Root directory path.
   * @param collection - Target collection (auto-created if missing).
   * @param options    - Directory ingestion options.
   */
  async ingestDirectory(
    path: string,
    collection: string,
    options: IngestDirectoryOptions = {},
  ): Promise<IngestResult[]> {
    const results = await this.#ingestion.ingestDirectory(path, collection, options);
    for (const r of results) {
      if (r.chunksCreated > 0) {
        this.#collections.recordIngest(collection, r.chunksCreated);
      }
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Document management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Removes all chunks for a document from the collection.
   *
   * @param documentId - Document identifier.
   * @param collection - Collection to remove from.
   */
  async removeDocument(documentId: string, collection: string): Promise<{ chunksRemoved: number }> {
    return this.#ingestion.removeDocument(documentId, collection);
  }

  /**
   * Removes every chunk matching the filter from the collection.
   * The filter must have at least one active field (mass-deletion guard);
   * use {@link deleteCollection} to wipe a whole collection.
   *
   * @param collection - Target collection.
   * @param filter     - Filter selecting the chunks to remove.
   */
  async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    return this.#ingestion.removeDocumentsByFilter(collection, filter);
  }

  /**
   * Updates metadata (`accessRoles`, `tags`, `language`, `author`, `title`,
   * `source`) on every chunk matching the filter WITHOUT re-embedding.
   * Typical use: re-stamping `accessRoles` after a permission change.
   *
   * @param collection - Target collection.
   * @param filter     - Filter selecting the chunks to update (must be non-empty).
   * @param patch      - Metadata fields to set.
   */
  async updateDocumentsMetadata(
    collection: string,
    filter: RAGFilter,
    patch: Partial<DocumentMetadata>,
  ): Promise<{ updated: number }> {
    return this.#ingestion.updateDocumentsMetadata(collection, filter, patch);
  }

  /**
   * Lists the distinct source-document IDs present in the collection.
   * Useful for consistency checks and orphan purging against an external
   * source of truth.
   *
   * @param collection - Collection to inspect.
   */
  async listDocumentIds(collection: string): Promise<string[]> {
    return this.#ingestion.listDocumentIds(collection);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a collection.
   *
   * @param name   - Collection name.
   * @param config - Collection configuration. Defaults are provided where possible.
   */
  async createCollection(name: string, config?: Partial<CollectionConfig>): Promise<void> {
    const defaults: CollectionConfig = {
      dimensions: this.#embeddingDefaults.dimensions,
      distanceMetric: 'cosine',
      embeddingProvider: this.#embeddingDefaults.embeddingProvider,
      embeddingModel: this.#embeddingDefaults.embeddingModel,
    };
    await this.#collections.create(name, { ...defaults, ...config });
  }

  /**
   * Lists all known collections.
   */
  async listCollections(): Promise<CollectionSummary[]> {
    return this.#collections.list();
  }

  /**
   * Checks that the underlying vector store is reachable and operational.
   * Useful for health endpoints in host applications.
   */
  async healthCheck(): Promise<boolean> {
    return this.#collections.healthCheck();
  }

  /**
   * Deletes a collection and ALL of its data from the underlying vector store,
   * and removes it from the manager's registry. Deleting a collection that
   * does not exist is a no-op.
   *
   * @param name - Collection to delete.
   */
  async deleteCollection(name: string): Promise<void> {
    return this.#collections.delete(name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Executes a RAG search query directly (without going through an AgentLoop).
   *
   * @param query   - RAG query parameters.
   * @param context - Execution context for tenant isolation and audit.
   */
  async search(query: RAGQuery, context: ExecutionContext): Promise<RAGResult> {
    return this.#ragPipeline.search(query, context);
  }

  /**
   * Probes the configured re-ranker. Call at startup so an unreachable or
   * misconfigured re-ranker surfaces in the boot log instead of failing a
   * user's first query. Never throws — inspect the returned value.
   *
   * @returns A {@link RerankerValidation} describing configuration and reachability.
   */
  async validateReranker(): Promise<RerankerValidation> {
    return this.#ragPipeline.validateReranker();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Deep API
  // ─────────────────────────────────────────────────────────────────────────

  /** Access the full RAGPipeline for advanced use cases. */
  get pipeline(): RAGPipeline {
    return this.#ragPipeline;
  }

  /** Access the IngestionPipeline for advanced ingestion control. */
  get ingestion(): IngestionPipeline {
    return this.#ingestion;
  }

  /** Access the CollectionManager for advanced collection management. */
  get collections(): CollectionManager {
    return this.#collections;
  }
}
