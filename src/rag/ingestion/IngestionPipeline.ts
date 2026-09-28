import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type {
  DocumentSource,
  IngestOptions,
  IngestResult,
  IngestProgress,
  IngestDirectoryOptions,
  ChunkingConfig,
} from './types.js';
import { EXTENSION_TO_MIME } from './types.js';
import type {
  DocumentMetadata,
  VectorDocument,
  CollectionConfig,
  RAGFilter,
} from '../../types/index.js';
import type { DocumentLoaderRegistry } from './DocumentLoaderRegistry.js';
import type { ChunkingStrategy } from './chunking/ChunkingStrategy.js';
import { RecursiveChunker } from './chunking/RecursiveChunker.js';
import { FixedSizeChunker } from './chunking/FixedSizeChunker.js';
import { MarkdownChunker } from './chunking/MarkdownChunker.js';
import type { EmbeddingRouter } from '../embedding/EmbeddingRouter.js';
import type { VectorStoreAdapter } from '../vectorstore/VectorStoreAdapter.js';
import type { EventBus } from '../../events/EventBus.js';
import type { TokenTracker } from '../../tokens/TokenTracker.js';
import { SDKError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

/** Full merged configuration used during a single ingest operation. */
interface ResolvedConfig {
  chunking: ChunkingConfig;
  embeddingBatchSize: number;
  upsertBatchSize: number;
  deduplication: boolean;
  overwriteExisting: boolean;
}

/** Pipeline options passed at construction time. */
export interface IngestionPipelineOptions {
  /** Default chunking config applied when IngestOptions.chunking is partial. */
  defaultChunking?: Partial<ChunkingConfig>;
  /** Default embedding provider name. Required for auto-creating collections. */
  defaultEmbeddingProvider?: string;
  /** Default collection configuration used when auto-creating collections. */
  defaultCollectionConfig?: Partial<CollectionConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// IngestionPipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * End-to-end document ingestion pipeline: load → chunk → embed → upsert.
 *
 * The pipeline handles individual documents, batches, and directories.
 * It supports content-hash deduplication and overwrite semantics, and emits
 * progress events through the {@link EventBus}.
 *
 * @example
 * ```typescript
 * const pipeline = new IngestionPipeline(
 *   loaderRegistry, new RecursiveChunker(), embeddingRouter, vectorStore, bus, tokens
 * );
 * const result = await pipeline.ingest({ type: 'file', path: './policy.pdf' }, 'docs');
 * ```
 */
export class IngestionPipeline {
  readonly #loaderRegistry: DocumentLoaderRegistry;
  readonly #embeddingRouter: EmbeddingRouter;
  readonly #vectorStore: VectorStoreAdapter;
  readonly #bus: EventBus;
  readonly #tokens: TokenTracker;
  readonly #options: IngestionPipelineOptions;

  /** chunk IDs per collection per document — used by removeDocument. */
  readonly #chunkIndex = new Map<string, Map<string, string[]>>();

  /** content hashes per collection per document — used by deduplication. */
  readonly #hashIndex = new Map<string, Map<string, Set<string>>>();

  /** collection configs tracked at ingestion time. */
  readonly #collectionConfigs = new Map<string, CollectionConfig>();

  constructor(
    loaderRegistry: DocumentLoaderRegistry,
    _chunker: ChunkingStrategy, // kept for API compatibility; strategy is selected per-ingest
    embeddingRouter: EmbeddingRouter,
    vectorStore: VectorStoreAdapter,
    bus: EventBus,
    tokens: TokenTracker,
    options: IngestionPipelineOptions = {},
  ) {
    this.#loaderRegistry = loaderRegistry;
    this.#embeddingRouter = embeddingRouter;
    this.#vectorStore = vectorStore;
    this.#bus = bus;
    this.#tokens = tokens;
    this.#options = options;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ingests a single document.
   *
   * Pipeline: load → chunk → (dedup) → embed (batch) → (overwrite) → upsert.
   *
   * @param source     - Document to ingest.
   * @param collection - Target vector store collection.
   * @param options    - Per-call options merged with pipeline defaults.
   * @returns {@link IngestResult}
   */
  async ingest(
    source: DocumentSource,
    collection: string,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const startTime = Date.now();
    const config = this.#resolveConfig(options);
    const errors: string[] = [];

    // 1. LOAD ────────────────────────────────────────────────────────────────
    this.#bus.emit('ingest.load.start', { source: source.path ?? source.url ?? source.type });
    const rawDoc = await this.#loaderRegistry.load(source);

    // Merge user metadata
    rawDoc.metadata = {
      ...rawDoc.metadata,
      ...options.metadata,
    };

    // Assign documentId if not already set
    if (!rawDoc.metadata.documentId) {
      rawDoc.metadata.documentId = randomUUID();
    }
    rawDoc.metadata.createdAt = rawDoc.metadata.createdAt ?? new Date();

    this.#bus.emit('ingest.load.end', {
      documentId: rawDoc.metadata.documentId,
      pages: rawDoc.pages,
    });

    // 2. CHUNK ───────────────────────────────────────────────────────────────
    this.#bus.emit('ingest.chunk.start', { documentId: rawDoc.metadata.documentId });
    const chunker = this.#selectChunker(config.chunking.strategy);
    let chunks = chunker.chunk(rawDoc, config.chunking);

    // Assign chunkIndex / totalChunks (chunkers do this, but ensure correctness)
    const totalChunks = chunks.length;
    chunks = chunks.map((c, idx) => ({
      ...c,
      index: idx,
      metadata: { ...c.metadata, chunkIndex: idx, totalChunks },
      contentHash: sha256(c.content),
    }));

    this.#bus.emit('ingest.chunk.end', { count: chunks.length });

    // 3. DEDUPLICATION ────────────────────────────────────────────────────────
    let skipped = 0;
    if (config.deduplication) {
      const existing = this.#getExistingHashes(collection, rawDoc.metadata.documentId);
      const before = chunks.length;
      chunks = chunks.filter((c) => !existing.has(c.contentHash));
      skipped = before - chunks.length;
    }

    // 4. ENSURE COLLECTION + EMBED ────────────────────────────────────────────
    const collConfig = await this.#ensureCollection(collection, config);
    const providerName = collConfig.embeddingProvider;

    this.#bus.emit('ingest.embed.start', { chunks: chunks.length });
    let totalTokens = 0;
    const vectorDocs: VectorDocument[] = [];

    for (let i = 0; i < chunks.length; i += config.embeddingBatchSize) {
      const batch = chunks.slice(i, i + config.embeddingBatchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await this.#embeddingRouter.embedBatch(texts, providerName);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const embedding = embeddings[j]!;
        vectorDocs.push({
          id: `${rawDoc.metadata.documentId}_chunk_${chunk.index}`,
          content: chunk.content,
          vector: embedding.vector,
          metadata: chunk.metadata,
        });
        totalTokens += embedding.tokensUsed ?? 0;
      }

      const processed = Math.min(i + config.embeddingBatchSize, chunks.length);
      const progress: IngestProgress = {
        phase: 'embedding',
        documentIndex: 0,
        totalDocuments: 1,
        chunksProcessed: processed,
        totalChunks: chunks.length,
        percentage: chunks.length > 0 ? Math.round((processed / chunks.length) * 100) : 100,
      };
      this.#bus.emit('ingest.progress', progress);
      options.onProgress?.(progress);
    }

    this.#bus.emit('ingest.embed.end', { tokensUsed: totalTokens });

    // 5. UPSERT ───────────────────────────────────────────────────────────────
    this.#bus.emit('ingest.upsert.start', { documents: vectorDocs.length });

    // Remove stale chunks before inserting new ones
    if (config.overwriteExisting) {
      await this.#deleteExistingChunks(collection, rawDoc.metadata.documentId);
    }

    for (let i = 0; i < vectorDocs.length; i += config.upsertBatchSize) {
      const batch = vectorDocs.slice(i, i + config.upsertBatchSize);
      await this.#vectorStore.upsert(collection, batch);
    }

    this.#bus.emit('ingest.upsert.end', { count: vectorDocs.length });

    // 6. UPDATE INDEXES ────────────────────────────────────────────────────────
    this.#updateChunkIndex(
      collection,
      rawDoc.metadata.documentId,
      vectorDocs.map((d) => d.id),
    );
    this.#updateHashIndex(
      collection,
      rawDoc.metadata.documentId,
      chunks.map((c) => c.contentHash),
    );

    // 7. RECORD TOKENS ────────────────────────────────────────────────────────
    if (totalTokens > 0) {
      // Token tracker records are fire-and-forget; ignore failures
      try {
        await this.#tokens.record(
          {
            tenantId: rawDoc.metadata.tenantId ?? 'unknown',
            userId: 'ingestion',
            sessionId: 'ingestion',
            agentId: 'ingestion',
            requestId: randomUUID(),
            roles: [],
          },
          {
            inputTokens: totalTokens,
            outputTokens: 0,
            totalTokens,
            cost: 0,
            provider: providerName,
            model: 'embedding',
            toolName: 'rag.ingest',
          },
        );
      } catch {
        // Non-critical
      }
    }

    const result: IngestResult = {
      documentId: rawDoc.metadata.documentId,
      source: source.path ?? source.url ?? (source.type === 'buffer' ? '[buffer]' : '[text]'),
      chunksCreated: vectorDocs.length,
      chunksSkipped: skipped,
      tokensUsed: totalTokens,
      durationMs: Date.now() - startTime,
      ...(errors.length > 0 && { errors }),
    };

    this.#bus.emit('ingest.complete', result);
    return result;
  }

  /**
   * Ingests multiple documents.
   *
   * Errors in individual documents are caught and recorded per-result;
   * they do not abort the batch.
   *
   * @param sources    - Documents to ingest.
   * @param collection - Target collection.
   * @param options    - Options applied to each ingest call.
   */
  async ingestBatch(
    sources: DocumentSource[],
    collection: string,
    options: IngestOptions = {},
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = [];

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      try {
        const result = await this.ingest(source, collection, options);
        results.push(result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.#bus.emit('ingest.error', {
          source: source.path ?? source.url ?? source.type,
          error: errMsg,
          phase: 'loading',
        });
        results.push({
          documentId: '',
          source: source.path ?? source.url ?? source.type,
          chunksCreated: 0,
          chunksSkipped: 0,
          tokensUsed: 0,
          durationMs: 0,
          errors: [errMsg],
        });
      }
    }

    return results;
  }

  /**
   * Ingests all supported files in a directory tree.
   *
   * @param directoryPath - Root directory to scan.
   * @param collection    - Target collection.
   * @param options       - Options, including `recursive` and `extensions` filters.
   */
  async ingestDirectory(
    directoryPath: string,
    collection: string,
    options: IngestDirectoryOptions = {},
  ): Promise<IngestResult[]> {
    const { recursive = true, extensions, ignorePatterns = ['node_modules', '.git'] } = options;

    const supportedExts = extensions
      ? new Set(extensions.map((e) => e.toLowerCase()))
      : new Set(Object.keys(EXTENSION_TO_MIME));

    const filePaths = await this.#collectFiles(
      directoryPath,
      supportedExts,
      ignorePatterns,
      recursive,
    );

    const sources: DocumentSource[] = filePaths.map((p) => ({ type: 'file' as const, path: p }));
    return this.ingestBatch(sources, collection, options);
  }

  /**
   * Removes all chunks for a document from the collection.
   *
   * The in-memory chunk index only covers documents ingested by THIS process
   * instance. When the index has no entry (typical after a restart), the
   * removal falls back to a store-level delete by `documentId` filter, so the
   * operation is correct across restarts and processes.
   *
   * @param documentId - Document to remove.
   * @param collection - Collection to remove from.
   */
  async removeDocument(documentId: string, collection: string): Promise<{ chunksRemoved: number }> {
    const chunkIds = this.#chunkIndex.get(collection)?.get(documentId) ?? [];

    let chunksRemoved: number;
    if (chunkIds.length > 0) {
      await this.#vectorStore.delete(collection, chunkIds);
      chunksRemoved = chunkIds.length;
    } else {
      const res = await this.#vectorStore.removeDocumentsByFilter(collection, { documentId });
      chunksRemoved = Math.max(res.removed, 0);
    }

    // Clear internal indexes
    this.#chunkIndex.get(collection)?.delete(documentId);
    this.#hashIndex.get(collection)?.delete(documentId);

    return { chunksRemoved };
  }

  /**
   * Removes every chunk matching the filter from the collection.
   * Thin wrapper over {@link VectorStoreAdapter.removeDocumentsByFilter} that
   * also clears the in-process indexes for the affected documents when the
   * filter targets specific `documentId`s.
   *
   * @param collection - Target collection.
   * @param filter     - Filter selecting the chunks to remove (must be non-empty).
   */
  async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    const res = await this.#vectorStore.removeDocumentsByFilter(collection, filter);
    if (filter.documentId !== undefined) {
      const ids = Array.isArray(filter.documentId) ? filter.documentId : [filter.documentId];
      for (const id of ids) {
        this.#chunkIndex.get(collection)?.delete(id);
        this.#hashIndex.get(collection)?.delete(id);
      }
    }
    return res;
  }

  /**
   * Updates metadata on every chunk matching the filter without re-embedding.
   * Thin wrapper over {@link VectorStoreAdapter.updateDocumentsMetadata}.
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
    return this.#vectorStore.updateDocumentsMetadata(collection, filter, patch);
  }

  /**
   * Lists the distinct source-document IDs present in the collection's store.
   * Useful for consistency checks against an external source of truth.
   *
   * @param collection - Collection to inspect.
   */
  async listDocumentIds(collection: string): Promise<string[]> {
    return this.#vectorStore.listDocumentIds(collection);
  }

  /**
   * Re-ingests a document: removes existing chunks then ingests fresh.
   *
   * @param source     - Document source.
   * @param collection - Target collection.
   * @param options    - Ingest options (deduplication is disabled for reingest).
   */
  async reingest(
    source: DocumentSource,
    collection: string,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    return this.ingest(source, collection, {
      ...options,
      overwriteExisting: true,
      deduplication: false,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #resolveConfig(options: IngestOptions): ResolvedConfig {
    const defaultChunking: ChunkingConfig = {
      strategy: 'recursive',
      chunkSize: 512,
      chunkOverlap: 50,
      minChunkSize: 100,
      ...this.#options.defaultChunking,
    };

    return {
      chunking: { ...defaultChunking, ...options.chunking },
      embeddingBatchSize: options.embeddingBatchSize ?? 50,
      upsertBatchSize: options.upsertBatchSize ?? 100,
      deduplication: options.deduplication ?? true,
      overwriteExisting: options.overwriteExisting ?? true,
    };
  }

  #selectChunker(strategy: ChunkingConfig['strategy']): ChunkingStrategy {
    switch (strategy) {
      case 'fixed_size':
        return new FixedSizeChunker();
      case 'markdown':
        return new MarkdownChunker();
      default:
        return new RecursiveChunker();
    }
  }

  async #ensureCollection(collection: string, _config: ResolvedConfig): Promise<CollectionConfig> {
    // Return cached config if we already know this collection
    const cached = this.#collectionConfigs.get(collection);
    if (cached) return cached;

    const exists = await this.#vectorStore.collectionExists(collection);

    if (exists) {
      // Build a CollectionConfig from what the store tells us. Prefer the
      // collection's own persisted embeddingProvider; only fall back to the
      // pipeline default when the store cannot report it (e.g. a collection
      // created outside the SDK).
      const info = await this.#vectorStore.collectionInfo(collection);
      const embeddingProvider =
        info.embeddingProvider !== ''
          ? info.embeddingProvider
          : (this.#options.defaultEmbeddingProvider ?? 'openai');
      const collConfig: CollectionConfig = {
        dimensions: info.dimensions,
        distanceMetric: info.distanceMetric,
        embeddingProvider,
        embeddingModel: info.embeddingModel,
      };
      this.#collectionConfigs.set(collection, collConfig);
      return collConfig;
    }

    // Auto-create with defaults
    const providerName = this.#options.defaultEmbeddingProvider ?? this.#firstProvider();
    const providerInfo = this.#embeddingRouter.getProviderInfo(providerName);

    const collConfig: CollectionConfig = {
      dimensions: providerInfo.dimensions,
      distanceMetric: 'cosine',
      embeddingProvider: providerName,
      embeddingModel: providerInfo.model,
      ...this.#options.defaultCollectionConfig,
    };

    await this.#vectorStore.createCollection(collection, collConfig);
    this.#collectionConfigs.set(collection, collConfig);

    return collConfig;
  }

  #firstProvider(): string {
    const providers = this.#embeddingRouter.listProviders();
    if (providers.length === 0) {
      throw new SDKError(
        'No embedding providers registered. Register at least one provider before ingesting.',
        'NO_EMBEDDING_PROVIDER',
      );
    }
    return providers[0]!;
  }

  #getExistingHashes(collection: string, _documentId: string): Set<string> {
    // Merge all hashes in the collection for cross-document deduplication
    const collectionMap = this.#hashIndex.get(collection);
    if (!collectionMap) return new Set();
    const merged = new Set<string>();
    for (const hashes of collectionMap.values()) {
      for (const h of hashes) merged.add(h);
    }
    return merged;
  }

  async #deleteExistingChunks(collection: string, documentId: string): Promise<void> {
    const chunkIds = this.#chunkIndex.get(collection)?.get(documentId) ?? [];
    if (chunkIds.length > 0) {
      await this.#vectorStore.delete(collection, chunkIds);
    }
    this.#chunkIndex.get(collection)?.delete(documentId);
    this.#hashIndex.get(collection)?.delete(documentId);
  }

  #updateChunkIndex(collection: string, documentId: string, ids: string[]): void {
    if (!this.#chunkIndex.has(collection)) {
      this.#chunkIndex.set(collection, new Map());
    }
    const existing = this.#chunkIndex.get(collection)!.get(documentId) ?? [];
    this.#chunkIndex.get(collection)!.set(documentId, [...new Set([...existing, ...ids])]);
  }

  #updateHashIndex(collection: string, documentId: string, hashes: string[]): void {
    if (!this.#hashIndex.has(collection)) {
      this.#hashIndex.set(collection, new Map());
    }
    const existing = this.#hashIndex.get(collection)!.get(documentId) ?? new Set<string>();
    for (const h of hashes) existing.add(h);
    this.#hashIndex.get(collection)!.set(documentId, existing);
  }

  async #collectFiles(
    dir: string,
    supportedExts: Set<string>,
    ignorePatterns: string[],
    recursive: boolean,
  ): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      // Skip ignored names
      if (ignorePatterns.some((p) => entry.name.includes(p))) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (recursive) {
          const nested = await this.#collectFiles(
            fullPath,
            supportedExts,
            ignorePatterns,
            recursive,
          );
          files.push(...nested);
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (supportedExts.has(ext)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// Re-export ChunkingStrategy so callers can type the constructor arg
export type { ChunkingStrategy };
