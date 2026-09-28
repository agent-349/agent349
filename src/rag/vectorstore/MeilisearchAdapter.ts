import { MeiliSearch } from 'meilisearch';
import type {
  Passage,
  RAGFilter,
  CollectionInfo,
  CollectionConfig,
  VectorDocument,
  DocumentMetadata,
} from '../types.js';
import { VectorStoreAdapter } from './VectorStoreAdapter.js';
import { RAGError } from '../../errors/RAGError.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the Meilisearch vector store adapter.
 */
export interface MeilisearchConfig {
  /** Meilisearch base URL. Default: `'http://localhost:7700'`. */
  url?: string;
  /** Master key or search API key. */
  apiKey?: string;
  /** HTTP request timeout in milliseconds. Default: 10000. */
  requestTimeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal document shape stored in Meilisearch
// ─────────────────────────────────────────────────────────────────────────────

interface MeilisearchDocument {
  id: string;
  content: string;
  documentId: string;
  title: string;
  source: string;
  collection: string;
  tenantId: string;
  accessRoles: string[];
  tags: string[];
  language: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  chunkIndex: number;
  totalChunks: number;
  contentHash: string;
  _vectors: { default: number[] };
}

// Index settings applied on creation
const INDEX_SETTINGS = {
  searchableAttributes: ['content', 'title'],
  filterableAttributes: [
    'tenantId',
    'accessRoles',
    'tags',
    'language',
    'author',
    'documentId',
    'createdAt',
    'updatedAt',
    'contentHash',
  ],
  sortableAttributes: ['createdAt', 'updatedAt', 'chunkIndex'],
};

// ─────────────────────────────────────────────────────────────────────────────
// MeilisearchAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by Meilisearch.
 *
 * Supports native hybrid search (keyword + vector) via Meilisearch's
 * `semanticRatio` parameter. Each SDK collection maps to a Meilisearch index.
 *
 * Embeddings are provided externally by the SDK's EmbeddingRouter;
 * Meilisearch's built-in auto-embedder is not used.
 *
 * @example
 * ```typescript
 * const store = new MeilisearchAdapter({ url: 'http://localhost:7700', apiKey: 'key' });
 * await store.createCollection('docs', { dimensions: 1536, distanceMetric: 'cosine', ... });
 * await store.upsert('docs', [{ id: 'a', content: 'hello', vector: [...], metadata: {...} }]);
 * const results = await store.search('docs', queryVector, 10);
 * ```
 */
export class MeilisearchAdapter extends VectorStoreAdapter {
  override readonly name = 'meilisearch';

  /**
   * Name of the auxiliary Meilisearch index used to persist collection metadata
   * (embeddingModel, dimensions, distanceMetric). This index is managed
   * internally by the SDK and should not be used directly.
   */
  static readonly META_INDEX = '__sdk_collections_meta';

  readonly #client: MeiliSearch;

  constructor(config: MeilisearchConfig = {}) {
    super();
    this.#client = new MeiliSearch({
      host: config.url ?? 'http://localhost:7700',
      ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
      ...(config.requestTimeout !== undefined && {
        requestConfig: { timeout: config.requestTimeout },
      }),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a Meilisearch index, applies the standard index settings, and
   * persists the collection metadata (embeddingModel, dimensions, distanceMetric)
   * in the auxiliary `__sdk_collections_meta` index so that `collectionInfo()`
   * can return accurate values at query time.
   */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    await this.#client.createIndex(collection, { primaryKey: 'id' }).waitTask();

    const index = this.#client.index(collection);
    await index.updateSettings(INDEX_SETTINGS).waitTask();

    // Configure the "userProvided" embedder so Meilisearch knows how to handle
    // the `_vectors.default` field during hybrid/vector search.
    await index
      .updateEmbedders({
        default: {
          source: 'userProvided',
          dimensions: config.dimensions,
        },
      })
      .waitTask();

    // Persist metadata in the auxiliary index so collectionInfo() can resolve
    // the embedding provider/model without it being stored per-document.
    await this.#ensureMetaIndex();
    await this.#client
      .index(MeilisearchAdapter.META_INDEX)
      .addDocuments([
        {
          id: collection,
          embeddingProvider: config.embeddingProvider,
          embeddingModel: config.embeddingModel,
          dimensions: config.dimensions,
          distanceMetric: config.distanceMetric,
          createdAt: new Date().toISOString(),
        },
      ])
      .waitTask();
  }

  /**
   * Deletes a Meilisearch index and all its documents.
   * Also removes the collection's entry from the metadata index.
   * Deleting a collection that does not exist is a no-op.
   *
   * @inheritdoc
   */
  override async deleteCollection(collection: string): Promise<void> {
    if (await this.collectionExists(collection)) {
      await this.#client.deleteIndex(collection).waitTask();
    }
    // Remove metadata entry — best-effort, don't fail if it doesn't exist.
    try {
      await this.#client.index(MeilisearchAdapter.META_INDEX).deleteDocument(collection).waitTask();
    } catch {
      // Metadata entry not found — nothing to do.
    }
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the filter has no active fields.
   */
  override async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    const builtFilter = this.#buildFilter(filter);
    if (builtFilter === undefined) {
      throw new RAGError(
        'Refusing to delete with an empty filter — use deleteCollection() to wipe a collection',
        'filter',
      );
    }
    const task = await this.#client
      .index(collection)
      .deleteDocuments({ filter: builtFilter })
      .waitTask();
    const removed = (task as { details?: { deletedDocuments?: number | null } }).details
      ?.deletedDocuments;
    return { removed: typeof removed === 'number' ? removed : -1 };
  }

  /**
   * @inheritdoc
   *
   * Implementation: collects the matching chunk IDs first (stable snapshot —
   * a patch that rewrites a filtered field like `tags` must not shift the
   * pagination underneath us), then applies partial document updates in
   * batches. Embeddings (`_vectors`) are never touched.
   *
   * @throws {@link RAGError} when the filter has no active fields.
   */
  override async updateDocumentsMetadata(
    collection: string,
    filter: RAGFilter,
    patch: Partial<DocumentMetadata>,
  ): Promise<{ updated: number }> {
    const builtFilter = this.#buildFilter(filter);
    if (builtFilter === undefined) {
      throw new RAGError('Refusing to update with an empty filter', 'filter');
    }
    const fields = toMeilisearchPatch(patch);
    if (Object.keys(fields).length === 0) return { updated: 0 };

    const index = this.#client.index(collection);
    const pageSize = 1000;

    // Phase 1: collect all matching IDs.
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await index.getDocuments<{ id: string }>({
        filter: builtFilter,
        fields: ['id'],
        limit: pageSize,
        offset,
      });
      for (const r of page.results) ids.push(r.id);
      if (page.results.length < pageSize) break;
      offset += pageSize;
    }

    // Phase 2: partial updates in batches (Meilisearch merges by primary key).
    for (let i = 0; i < ids.length; i += pageSize) {
      const batch = ids.slice(i, i + pageSize).map((id) => ({ id, ...fields }));
      await index.updateDocuments(batch).waitTask();
    }

    return { updated: ids.length };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const index = this.#client.index(collection);
    const ids = new Set<string>();
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const page = await index.getDocuments<{ documentId?: string }>({
        fields: ['documentId'],
        limit: pageSize,
        offset,
      });
      for (const r of page.results) {
        if (r.documentId !== undefined && r.documentId !== '') ids.add(r.documentId);
      }
      if (page.results.length < pageSize) break;
      offset += pageSize;
    }
    return [...ids];
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    try {
      await this.#client.getIndex(collection);
      return true;
    } catch {
      return false;
    }
  }

  /** @inheritdoc */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const index = await this.#client.getIndex(collection);
    const stats = await index.getStats();

    // Retrieve persisted metadata from the auxiliary index.
    let embeddingProvider = '';
    let embeddingModel = '';
    let dimensions = 0;
    let distanceMetric: CollectionInfo['distanceMetric'] = 'cosine';

    try {
      const meta = await this.#client.index(MeilisearchAdapter.META_INDEX).getDocument<{
        embeddingProvider?: string;
        embeddingModel: string;
        dimensions: number;
        distanceMetric: CollectionInfo['distanceMetric'];
      }>(collection);
      embeddingProvider = meta.embeddingProvider ?? '';
      embeddingModel = meta.embeddingModel;
      dimensions = meta.dimensions;
      distanceMetric = meta.distanceMetric;
    } catch {
      // Collection was created outside the SDK — metadata not available.
      // Callers should handle empty strings as "unknown".
    }

    return {
      name: collection,
      documentCount: stats.numberOfDocuments,
      dimensions,
      embeddingProvider,
      embeddingModel,
      distanceMetric,
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      return await this.#client.isHealthy();
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upserts documents into the Meilisearch index.
   *
   * Transforms each {@link VectorDocument} into the Meilisearch document
   * format, placing the embedding in `_vectors.default`.
   */
  override async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    const index = this.#client.index(collection);
    const meilisearchDocs = documents.map((doc) => this.#toMeilisearchDoc(doc, collection));
    await index.addDocuments(meilisearchDocs, { primaryKey: 'id' }).waitTask();
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#client.index(collection).deleteDocuments(ids).waitTask();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pure vector (semantic) search — `semanticRatio: 1.0`.
   *
   * @inheritdoc
   */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const builtFilter = this.#buildFilter(filter);
    const result = await this.#client.index(collection).search('', {
      vector,
      limit: topK,
      ...(builtFilter !== undefined && { filter: builtFilter }),
      hybrid: { semanticRatio: 1.0, embedder: 'default' },
      showRankingScore: true,
    });
    return result.hits.map((hit) => this.#toPassage(hit as Record<string, unknown>, collection));
  }

  /**
   * Pure keyword (full-text) search — `semanticRatio: 0.0`.
   *
   * @inheritdoc
   */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const builtFilter = this.#buildFilter(filter);
    const result = await this.#client.index(collection).search(query, {
      limit: topK,
      ...(builtFilter !== undefined && { filter: builtFilter }),
      hybrid: { semanticRatio: 0.0, embedder: 'default' },
      showRankingScore: true,
    });
    return result.hits.map((hit) => this.#toPassage(hit as Record<string, unknown>, collection));
  }

  /**
   * Hybrid search combining vector similarity and keyword matching.
   *
   * The `alpha` parameter maps directly to Meilisearch's `semanticRatio`:
   * `0` = pure keyword, `1` = pure vector.
   *
   * @inheritdoc
   */
  override async hybridSearch(
    collection: string,
    vector: number[],
    query: string,
    topK: number,
    alpha: number,
    filter?: RAGFilter,
    _rrfK?: number,
  ): Promise<Passage[]> {
    const builtFilter = this.#buildFilter(filter);
    const result = await this.#client.index(collection).search(query, {
      vector,
      limit: topK,
      ...(builtFilter !== undefined && { filter: builtFilter }),
      hybrid: { semanticRatio: alpha, embedder: 'default' },
      showRankingScore: true,
    });
    return result.hits.map((hit) => this.#toPassage(hit as Record<string, unknown>, collection));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds a Meilisearch filter string from a {@link RAGFilter}.
   *
   * Filter grammar:
   * ```
   * tenantId = 'acme' AND (accessRoles IN ['finance', '*'] OR accessRoles IS EMPTY) AND tags IN ['hr']
   * ```
   *
   * The access-roles clause ensures a document is visible if:
   * 1. It carries the user's role, OR
   * 2. It carries the wildcard `'*'` role, OR
   * 3. Its `accessRoles` field is empty (public document).
   */
  #buildFilter(filter?: RAGFilter): string | undefined {
    if (!filter) return undefined;

    const conditions: string[] = [];

    if (filter.tenantId) {
      conditions.push(`tenantId = '${escapeFilterValue(filter.tenantId)}'`);
    }

    if (filter.accessRoles && filter.accessRoles.length > 0) {
      const rolesWithWildcard = [...filter.accessRoles, '*'];
      const rolesList = rolesWithWildcard.map((r) => `'${escapeFilterValue(r)}'`).join(', ');
      conditions.push(`(accessRoles IN [${rolesList}] OR accessRoles IS EMPTY)`);
    }

    if (filter.tags && filter.tags.length > 0) {
      const tagsList = filter.tags.map((t) => `'${escapeFilterValue(t)}'`).join(', ');
      conditions.push(`tags IN [${tagsList}]`);
    }

    // AND semantics: one condition per tag (`tags = 'x'` matches array membership).
    if (filter.tagsAll && filter.tagsAll.length > 0) {
      for (const tag of filter.tagsAll) {
        conditions.push(`tags = '${escapeFilterValue(tag)}'`);
      }
    }

    if (filter.documentId !== undefined) {
      const wanted = Array.isArray(filter.documentId) ? filter.documentId : [filter.documentId];
      if (wanted.length > 0) {
        const list = wanted.map((d) => `'${escapeFilterValue(d)}'`).join(', ');
        conditions.push(`documentId IN [${list}]`);
      }
    }

    if (filter.language) {
      conditions.push(`language = '${escapeFilterValue(filter.language)}'`);
    }

    if (filter.dateRange?.from) {
      conditions.push(`createdAt >= ${filter.dateRange.from.getTime()}`);
    }

    if (filter.dateRange?.to) {
      conditions.push(`createdAt <= ${filter.dateRange.to.getTime()}`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : undefined;
  }

  /** Converts a Meilisearch search hit to a {@link Passage}. */
  #toPassage(hit: Record<string, unknown>, collection: string): Passage {
    return {
      id: (hit['id'] as string | undefined) ?? '',
      content: (hit['content'] as string | undefined) ?? '',
      score: (hit['_rankingScore'] as number | undefined) ?? 0,
      collection,
      metadata: {
        documentId: (hit['documentId'] as string | undefined) ?? '',
        ...(hit['title'] !== undefined && { title: hit['title'] as string }),
        ...(hit['source'] !== undefined && { source: hit['source'] as string }),
        ...(hit['mimeType'] !== undefined && { mimeType: hit['mimeType'] as string }),
        ...(hit['language'] !== undefined && { language: hit['language'] as string }),
        ...(hit['author'] !== undefined && { author: hit['author'] as string }),
        ...(Array.isArray(hit['tags']) && { tags: hit['tags'] as string[] }),
        ...(hit['tenantId'] !== undefined && { tenantId: hit['tenantId'] as string }),
        ...(Array.isArray(hit['accessRoles']) && { accessRoles: hit['accessRoles'] as string[] }),
        ...(typeof hit['chunkIndex'] === 'number' && { chunkIndex: hit['chunkIndex'] }),
        ...(typeof hit['totalChunks'] === 'number' && { totalChunks: hit['totalChunks'] }),
        ...(typeof hit['createdAt'] === 'number' && {
          createdAt: new Date(hit['createdAt']),
        }),
        ...(typeof hit['updatedAt'] === 'number' && {
          updatedAt: new Date(hit['updatedAt']),
        }),
      },
    };
  }

  /** Converts a {@link VectorDocument} to the Meilisearch document format. */
  #toMeilisearchDoc(doc: VectorDocument, collection: string): MeilisearchDocument {
    const meta = doc.metadata;
    return {
      id: doc.id,
      content: doc.content,
      documentId: meta.documentId,
      title: meta.title ?? '',
      source: meta.source ?? '',
      collection,
      tenantId: meta.tenantId ?? '',
      accessRoles: meta.accessRoles ?? [],
      tags: meta.tags ?? [],
      language: meta.language ?? '',
      author: meta.author ?? '',
      createdAt: meta.createdAt instanceof Date ? meta.createdAt.getTime() : 0,
      updatedAt: meta.updatedAt instanceof Date ? meta.updatedAt.getTime() : 0,
      chunkIndex: meta.chunkIndex ?? 0,
      totalChunks: meta.totalChunks ?? 0,
      contentHash: (meta.custom?.['contentHash'] as string | undefined) ?? '',
      _vectors: { default: doc.vector },
    };
  }

  /**
   * Ensures the auxiliary metadata index exists, creating it if necessary.
   * Called before any write to `__sdk_collections_meta`.
   */
  async #ensureMetaIndex(): Promise<void> {
    const exists = await this.collectionExists(MeilisearchAdapter.META_INDEX);
    if (!exists) {
      await this.#client
        .createIndex(MeilisearchAdapter.META_INDEX, { primaryKey: 'id' })
        .waitTask();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escapes single quotes in a Meilisearch filter value.
 *
 * Meilisearch uses single-quote-delimited strings in its filter grammar.
 * An embedded `'` must be doubled (`''`) to prevent filter injection.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Maps the patchable subset of {@link DocumentMetadata} to Meilisearch document
 * fields. Unknown/immutable fields are ignored; `updatedAt` is stamped
 * automatically when at least one field is patched.
 */
function toMeilisearchPatch(patch: Partial<DocumentMetadata>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.accessRoles !== undefined) out['accessRoles'] = patch.accessRoles;
  if (patch.tags !== undefined) out['tags'] = patch.tags;
  if (patch.language !== undefined) out['language'] = patch.language;
  if (patch.author !== undefined) out['author'] = patch.author;
  if (patch.title !== undefined) out['title'] = patch.title;
  if (patch.source !== undefined) out['source'] = patch.source;
  if (Object.keys(out).length > 0) out['updatedAt'] = Date.now();
  return out;
}
