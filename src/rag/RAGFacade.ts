import type { StopWordsApplyResult } from '../types/index.js';
import type {
  ExecutionContext,
  CollectionConfig,
  DocumentMetadata,
  ModelValidation,
  QueryRewriterValidation,
} from '../types/index.js';
import type { RAGQuery, RAGResult, RAGFilter, RerankerValidation } from './types.js';
import type { RAGPipeline } from './RAGPipeline.js';
import type { IngestionPipeline } from './ingestion/IngestionPipeline.js';
import type { CollectionManager } from './collections/CollectionManager.js';
import type { ReferenceExtractor, DocumentIdentity } from './references/ReferenceExtractor.js';
import type { DocumentIdentifier } from './references/DocumentIdentifier.js';
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

/** A document identity with its model fallback ({@link RAGFacade.identifyDocument}). */
export interface DocumentIdentityResult extends Omit<DocumentIdentity, 'identities'> {
  identities: { key: string; label: string; source: 'title' | 'header' | 'llm' }[];
  /** The model fallback ran (`rag.legal.identity.llm.mode: 'fallback'` and nothing else found). */
  model?: {
    name: string;
    latencyMs: number;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

/** Document identification pieces built from `rag.legal`. */
export interface RAGFacadeIdentification {
  references: ReferenceExtractor;
  identifier?: DocumentIdentifier;
  /** `rag.legal.identity.llm.mode`. */
  llmMode: 'off' | 'fallback';
}

export class RAGFacade {
  readonly #ragPipeline: RAGPipeline;
  readonly #ingestion: IngestionPipeline;
  readonly #collections: CollectionManager;
  readonly #embeddingDefaults: RAGFacadeEmbeddingDefaults;
  readonly #identification: RAGFacadeIdentification | undefined;

  constructor(
    ragPipeline: RAGPipeline,
    ingestionPipeline: IngestionPipeline,
    collectionManager: CollectionManager,
    embeddingDefaults?: RAGFacadeEmbeddingDefaults,
    identification?: RAGFacadeIdentification,
  ) {
    this.#identification = identification;
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
    // Native stop words (rag.lexicon) for the collection's languages, unless
    // the caller set them explicitly.
    const lexicon =
      config?.stopWords === undefined
        ? this.#ragPipeline.stopWordsForCreation(config?.languages)
        : {};
    await this.#collections.create(name, { ...defaults, ...lexicon, ...config });
  }

  /**
   * Applies the configured stop words (`rag.lexicon`) natively to an existing
   * collection for its languages, or clears them when stop words are off.
   * Call it when the collection's languages or the stop-word settings change:
   * on Meilisearch and pgvector it rewrites the index.
   *
   * @param name    - Collection name.
   * @param options - Languages of the collection (ISO 639-1).
   * @returns What the engine did; `reason` explains a collection left as is.
   */
  async configureCollection(
    name: string,
    options: { languages?: string[] } = {},
  ): Promise<StopWordsApplyResult> {
    return this.#ragPipeline.configureStopWords(name, options.languages ?? []);
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

  /**
   * Probes the configured query rewriter with a real request. A rewriter that
   * cannot reach its model never fails a search — it silently keeps the
   * original query — so this startup check is where the problem surfaces.
   * Never throws — inspect the returned value.
   *
   * @returns A {@link QueryRewriterValidation} describing configuration and reachability.
   */
  async validateQueryRewriter(): Promise<QueryRewriterValidation> {
    return this.#ragPipeline.validateQueryRewriter();
  }

  /**
   * Probes the default embedding provider by embedding a short text.
   * Never throws — inspect the returned value.
   *
   * @returns A {@link ModelValidation} with role `'embedding'`.
   */
  async validateEmbedding(): Promise<ModelValidation> {
    const { embeddingProvider, embeddingModel } = this.#embeddingDefaults;
    const model = embeddingModel.startsWith(`${embeddingProvider}/`)
      ? embeddingModel.slice(embeddingProvider.length + 1)
      : embeddingModel;
    return this.#ragPipeline.validateEmbedding(embeddingProvider, model);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Document identity
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The identity of a document — which norm it is — from its title and the
   * heading of its text (`rag.legal`), and, when neither gives one and
   * `rag.legal.identity.llm.mode` is `fallback`, from a model. Hosts store
   * the keys with the document so that references and relations from other
   * documents reach it. Never throws.
   *
   * @param input.title - Document title or file name.
   * @param input.text  - Document text (only its beginning is read).
   */
  async identifyDocument(input: { title: string; text?: string }): Promise<DocumentIdentityResult> {
    const id = this.#identification;
    if (id === undefined) return { keys: [], identities: [], conflicts: [] };
    const found = id.references.identifyDocument(input.title, input.text);
    if (found.keys.length > 0 || id.llmMode !== 'fallback' || id.identifier === undefined) {
      return found;
    }
    const r = await id.identifier.identify(input.title, input.text ?? '');
    const model = {
      name: r.model,
      latencyMs: r.latencyMs,
      ...(r.error !== undefined && { error: r.error }),
      ...(r.inputTokens !== undefined && { inputTokens: r.inputTokens }),
      ...(r.outputTokens !== undefined && { outputTokens: r.outputTokens }),
    };
    if (r.identity === undefined) return { ...found, model };
    return {
      keys: [r.identity.key],
      identities: [{ ...r.identity, source: 'llm' }],
      conflicts: [],
      model,
    };
  }

  /**
   * Probes the model of `rag.legal.identity.llm` (only with `mode: 'fallback'`).
   * Never throws.
   */
  async validateDocumentIdentifier(): Promise<ModelValidation> {
    const id = this.#identification;
    if (id?.identifier === undefined || id.llmMode !== 'fallback') {
      return { role: 'documentIdentifier', configured: false, available: false };
    }
    const start = Date.now();
    const probe = await id.identifier.validate();
    return {
      role: 'documentIdentifier',
      configured: true,
      provider: id.identifier.provider,
      model: id.identifier.model,
      available: probe.ok,
      latencyMs: Date.now() - start,
      ...(!probe.ok && { error: probe.error ?? 'the identification probe did not succeed' }),
    };
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
