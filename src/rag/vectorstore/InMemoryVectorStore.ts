import type {
  Passage,
  RAGFilter,
  CollectionInfo,
  CollectionConfig,
  VectorDocument,
  DocumentMetadata,
} from '../types.js';
import { VectorStoreAdapter } from './VectorStoreAdapter.js';
import { reciprocalRankFusion } from '../fusion/RRF.js';
import { SDKError } from '../../errors/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface StoredCollection {
  config: CollectionConfig;
  documents: Map<string, VectorDocument>;
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryVectorStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory vector store adapter for unit testing and local development.
 *
 * Implements the full {@link VectorStoreAdapter} interface without any external
 * dependencies. All data is held in a `Map` and is discarded on process exit.
 *
 * **Search algorithms:**
 * - **`search()`** — cosine similarity between the query vector and each stored
 *   document vector. Scores are normalised to [0, 1] via `(cosine + 1) / 2`.
 * - **`keywordSearch()`** — simple full-text token overlap. The score is the
 *   fraction of unique query tokens found anywhere in the document content
 *   (case-insensitive). Documents with zero overlap are excluded.
 * - **`hybridSearch()`** — runs `search()` and `keywordSearch()` in parallel,
 *   then merges the two ranked lists using Reciprocal Rank Fusion (RRF)
 *   controlled by `alpha`.
 *
 * **Filters:** `tenantId`, `language`, `tags` (OR), `tagsAll` (AND),
 * `documentId` (exact / IN), `accessRoles` (overlap), `dateRange` (on
 * `metadata.createdAt`), and `metadata` (key-value exact match against
 * `metadata.custom`).
 *
 * @example
 * ```typescript
 * const store = new InMemoryVectorStore();
 * await store.createCollection('docs', {
 *   dimensions: 3,
 *   distanceMetric: 'cosine',
 *   embeddingProvider: 'openai',
 *   embeddingModel: 'text-embedding-3-small',
 * });
 * await store.upsert('docs', [{ id: 'a', content: 'hello', vector: [1, 0, 0], metadata: { documentId: 'a' } }]);
 * const results = await store.search('docs', [1, 0, 0], 5);
 * ```
 */
export class InMemoryVectorStore extends VectorStoreAdapter {
  override readonly name = 'in-memory';

  readonly #collections = new Map<string, StoredCollection>();

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates (or replaces) a collection with the provided configuration.
   *
   * Replacing an existing collection erases all stored documents.
   */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    this.#collections.set(collection, { config, documents: new Map() });
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    return this.#collections.has(collection);
  }

  /**
   * @inheritdoc
   * Deleting a collection that does not exist is a no-op.
   */
  override async deleteCollection(collection: string): Promise<void> {
    this.#collections.delete(collection);
  }

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const col = this.#requireCollection(collection);
    return {
      name: collection,
      documentCount: col.documents.size,
      dimensions: col.config.dimensions,
      embeddingProvider: col.config.embeddingProvider,
      embeddingModel: col.config.embeddingModel,
      distanceMetric: col.config.distanceMetric,
    };
  }

  /** Always returns `true` — no external service to check. */
  override async healthCheck(): Promise<boolean> {
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    const col = this.#requireCollection(collection);
    for (const doc of documents) {
      col.documents.set(doc.id, doc);
    }
  }

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async delete(collection: string, ids: string[]): Promise<void> {
    const col = this.#requireCollection(collection);
    for (const id of ids) {
      col.documents.delete(id);
    }
  }

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist,
   *         or `EMPTY_FILTER` when the filter has no active fields.
   */
  override async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    const col = this.#requireCollection(collection);
    requireNonEmptyFilter(filter);
    let removed = 0;
    for (const [id, doc] of col.documents) {
      if (matchesFilter(doc.metadata, filter)) {
        col.documents.delete(id);
        removed++;
      }
    }
    return { removed };
  }

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist,
   *         or `EMPTY_FILTER` when the filter has no active fields.
   */
  override async updateDocumentsMetadata(
    collection: string,
    filter: RAGFilter,
    patch: Partial<DocumentMetadata>,
  ): Promise<{ updated: number }> {
    const col = this.#requireCollection(collection);
    requireNonEmptyFilter(filter);
    const fields = pickPatchableMetadata(patch);
    let updated = 0;
    for (const [id, doc] of col.documents) {
      if (matchesFilter(doc.metadata, filter)) {
        col.documents.set(id, {
          ...doc,
          metadata: { ...doc.metadata, ...fields, updatedAt: new Date() },
        });
        updated++;
      }
    }
    return { updated };
  }

  /**
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const col = this.#requireCollection(collection);
    const ids = new Set<string>();
    for (const doc of col.documents.values()) {
      if (doc.metadata.documentId !== undefined && doc.metadata.documentId !== '') {
        ids.add(doc.metadata.documentId);
      }
    }
    return [...ids];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Semantic search via cosine similarity.
   *
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const col = this.#requireCollection(collection);
    const candidates = this.#applyFilter([...col.documents.values()], filter);

    return candidates
      .map((doc) => this.#toPassage(doc, collection, cosineSimilarity(vector, doc.vector)))
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Full-text keyword search using simple token overlap.
   *
   * The score equals the fraction of unique query tokens found in the document
   * content (case-insensitive). Documents with zero overlap are excluded.
   *
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const col = this.#requireCollection(collection);
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    const candidates = this.#applyFilter([...col.documents.values()], filter);

    return candidates
      .map((doc) => {
        const docTokens = tokenize(doc.content);
        let matches = 0;
        for (const token of queryTokens) {
          if (docTokens.has(token)) matches++;
        }
        const score = matches / queryTokens.size;
        return this.#toPassage(doc, collection, score);
      })
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Hybrid search combining vector similarity and keyword matching via RRF.
   *
   * Runs `search()` and `keywordSearch()` in parallel and merges the results
   * with {@link reciprocalRankFusion} using the provided `alpha`.
   *
   * @inheritdoc
   * @throws {@link SDKError} with code `COLLECTION_NOT_FOUND` when the collection does not exist.
   */
  override async hybridSearch(
    collection: string,
    vector: number[],
    query: string,
    topK: number,
    alpha: number,
    filter?: RAGFilter,
    rrfK?: number,
  ): Promise<Passage[]> {
    const [vectorResults, keywordResults] = await Promise.all([
      this.search(collection, vector, topK, filter),
      this.keywordSearch(collection, query, topK, filter),
    ]);
    return reciprocalRankFusion(vectorResults, keywordResults, alpha, rrfK).slice(0, topK);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #requireCollection(name: string): StoredCollection {
    const col = this.#collections.get(name);
    if (col === undefined) {
      throw new SDKError(`Collection '${name}' does not exist`, 'COLLECTION_NOT_FOUND');
    }
    return col;
  }

  #toPassage(doc: VectorDocument, collection: string, score: number): Passage {
    return {
      id: doc.id,
      content: doc.content,
      score,
      metadata: doc.metadata,
      collection,
    };
  }

  #applyFilter(docs: VectorDocument[], filter: RAGFilter | undefined): VectorDocument[] {
    if (filter === undefined) return docs;
    return docs.filter((doc) => matchesFilter(doc.metadata, filter));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions (module-private)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors, normalised to [0, 1].
 *
 * Returns 0 for zero-length vectors to avoid division by zero.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  // Map [-1, 1] → [0, 1]
  return (dot / (Math.sqrt(normA) * Math.sqrt(normB)) + 1) / 2;
}

/**
 * Splits text into a set of lowercase tokens (letters/digits only).
 * Empty tokens are discarded.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 0),
  );
}

/** Metadata fields that may be patched via `updateDocumentsMetadata`. */
function pickPatchableMetadata(patch: Partial<DocumentMetadata>): Partial<DocumentMetadata> {
  const out: Partial<DocumentMetadata> = {};
  if (patch.accessRoles !== undefined) out.accessRoles = patch.accessRoles;
  if (patch.tags !== undefined) out.tags = patch.tags;
  if (patch.language !== undefined) out.language = patch.language;
  if (patch.author !== undefined) out.author = patch.author;
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.source !== undefined) out.source = patch.source;
  return out;
}

/**
 * Throws when the filter has no active field. Guard against accidental mass
 * deletion/update — wiping a whole collection must go through `deleteCollection()`.
 */
function requireNonEmptyFilter(filter: RAGFilter): void {
  const hasDocumentId =
    typeof filter.documentId === 'string' ||
    (Array.isArray(filter.documentId) && filter.documentId.length > 0);
  const active =
    filter.tenantId !== undefined ||
    (filter.tags !== undefined && filter.tags.length > 0) ||
    (filter.tagsAll !== undefined && filter.tagsAll.length > 0) ||
    hasDocumentId ||
    filter.language !== undefined ||
    filter.dateRange !== undefined ||
    (filter.accessRoles !== undefined && filter.accessRoles.length > 0) ||
    (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0);
  if (!active) {
    throw new SDKError(
      'Refusing to operate with an empty filter — use deleteCollection() to wipe a collection',
      'EMPTY_FILTER',
    );
  }
}

/**
 * Returns `true` when a document's metadata satisfies all active filter fields.
 */
function matchesFilter(meta: DocumentMetadata, filter: RAGFilter): boolean {
  if (filter.tenantId !== undefined && meta.tenantId !== filter.tenantId) {
    return false;
  }
  if (filter.language !== undefined && meta.language !== filter.language) {
    return false;
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    const docTags = meta.tags ?? [];
    if (!filter.tags.some((tag) => docTags.includes(tag))) return false;
  }
  if (filter.tagsAll !== undefined && filter.tagsAll.length > 0) {
    const docTags = meta.tags ?? [];
    if (!filter.tagsAll.every((tag) => docTags.includes(tag))) return false;
  }
  if (filter.documentId !== undefined) {
    const wanted = Array.isArray(filter.documentId) ? filter.documentId : [filter.documentId];
    if (!wanted.includes(meta.documentId)) return false;
  }
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    // Documents with no accessRoles are publicly accessible — skip the check.
    // A document carrying the wildcard role '*' is visible to every role, as in
    // the database-backed adapters.
    const docRoles = meta.accessRoles;
    if (docRoles !== undefined && docRoles.length > 0 && !docRoles.includes('*')) {
      if (!filter.accessRoles.some((role) => docRoles.includes(role))) return false;
    }
  }
  if (filter.dateRange !== undefined) {
    const createdAt = meta.createdAt;
    if (filter.dateRange.from !== undefined) {
      if (createdAt === undefined || createdAt < filter.dateRange.from) return false;
    }
    if (filter.dateRange.to !== undefined) {
      if (createdAt === undefined || createdAt > filter.dateRange.to) return false;
    }
  }
  if (filter.metadata !== undefined) {
    const custom = meta.custom ?? {};
    for (const [key, val] of Object.entries(filter.metadata)) {
      if (custom[key] !== val) return false;
    }
  }
  return true;
}
