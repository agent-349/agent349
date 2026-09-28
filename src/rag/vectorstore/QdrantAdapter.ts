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
import { RAGError } from '../../errors/RAGError.js';
import {
  batches,
  bm25DocumentVector,
  bm25QueryVector,
  chunkUuid,
  documentIdList,
  requestJson,
  requireActiveFilter,
  requireScalarMetadataFilter,
  scaleByMax,
  toChunkPatch,
  toChunkRecord,
  toPassage,
  trimBaseUrl,
  vectorScore,
  visibleRoles,
  str,
  defaultFetch,
} from './common.js';
import type { ChunkRecord, FetchLike, HttpClientOptions } from './common.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for {@link QdrantAdapter}. */
export interface QdrantConfig {
  /** Qdrant REST endpoint. Default: `'http://localhost:6333'`. */
  url?: string;
  /** API key (Qdrant Cloud or a secured instance). */
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 10 000. */
  timeoutMs?: number;
  /** Prefix of every collection the adapter creates. Default: `''`. */
  collectionPrefix?: string;
  /** Custom `fetch` implementation (testing, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
}

const DENSE = 'dense';
const SPARSE = 'text';
const PAGE = 256;
const DISTANCE: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: 'Cosine',
  dot: 'Dot',
  euclidean: 'Euclid',
};
const KEYWORD_FIELDS = ['tenantId', 'documentId', 'accessRoles', 'tags', 'language'];

interface QdrantPoint {
  id: string;
  score?: number;
  payload?: Partial<ChunkRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// QdrantAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by [Qdrant](https://qdrant.tech), over its REST API.
 *
 * Each collection is a Qdrant collection with a named dense vector (`dense`)
 * and a sparse vector (`text`) with the IDF modifier. Keyword search encodes
 * text as BM25 term-frequency sparse vectors and lets Qdrant apply IDF, which
 * yields BM25 scoring. Hybrid search fuses both rankings with RRF.
 *
 * Point IDs must be UUIDs in Qdrant, so each chunk is stored under a
 * deterministic UUID derived from its ID, with the original ID in the payload.
 * Collection metadata lives in the auxiliary collection
 * `<collectionPrefix>agent349_collections`.
 *
 * No client library is needed: the adapter uses `fetch`.
 */
export class QdrantAdapter extends VectorStoreAdapter {
  override readonly name = 'qdrant';

  readonly #http: HttpClientOptions;
  readonly #prefix: string;
  readonly #metaCollection: string;
  readonly #metrics = new Map<string, CollectionConfig['distanceMetric']>();

  constructor(config: QdrantConfig = {}) {
    super();
    this.#http = {
      baseUrl: trimBaseUrl(config.url ?? 'http://localhost:6333'),
      headers:
        config.apiKey !== undefined && config.apiKey !== '' ? { 'api-key': config.apiKey } : {},
      timeoutMs: config.timeoutMs ?? 10_000,
      fetch: config.fetch ?? defaultFetch,
      adapter: 'qdrant',
    };
    this.#prefix = config.collectionPrefix ?? '';
    this.#metaCollection = `${this.#prefix}agent349_collections`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates the Qdrant collection (dense + sparse vectors), its payload
   * indexes, and its metadata entry. An existing collection is kept.
   */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    const name = this.#name(collection);
    if (!(await this.#exists(name))) {
      await this.#request('PUT', `/collections/${enc(name)}`, {
        vectors: {
          [DENSE]: { size: config.dimensions, distance: DISTANCE[config.distanceMetric] },
        },
        sparse_vectors: { [SPARSE]: { modifier: 'idf' } },
      });
      for (const field of KEYWORD_FIELDS) {
        await this.#createIndex(name, field, 'keyword');
      }
      await this.#createIndex(name, 'createdAt', 'integer');
    }
    await this.#ensureMetaCollection();
    await this.#request('PUT', `/collections/${enc(this.#metaCollection)}/points?wait=true`, {
      points: [
        {
          id: chunkUuid(collection),
          vector: { meta: [1] },
          payload: {
            name: collection,
            embeddingProvider: config.embeddingProvider,
            embeddingModel: config.embeddingModel,
            dimensions: config.dimensions,
            distanceMetric: config.distanceMetric,
          },
        },
      ],
    });
    this.#metrics.set(collection, config.distanceMetric);
  }

  /** Deletes the collection and its metadata entry. A missing collection is a no-op. */
  override async deleteCollection(collection: string): Promise<void> {
    const name = this.#name(collection);
    if (await this.#exists(name)) {
      await this.#request('DELETE', `/collections/${enc(name)}`);
    }
    if (await this.#exists(this.#metaCollection)) {
      await this.#request(
        'POST',
        `/collections/${enc(this.#metaCollection)}/points/delete?wait=true`,
        {
          points: [chunkUuid(collection)],
        },
      );
    }
    this.#metrics.delete(collection);
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    return this.#exists(this.#name(collection));
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const name = this.#name(collection);
    if (!(await this.#exists(name))) {
      throw new RAGError(`qdrant: collection '${collection}' does not exist`, 'collection');
    }
    const count = await this.#request<{ result: { count: number } }>(
      'POST',
      `/collections/${enc(name)}/points/count`,
      { exact: true },
    );
    const meta = await this.#meta(collection);
    return {
      name: collection,
      documentCount: count.result.count,
      dimensions: meta?.dimensions ?? 0,
      embeddingProvider: meta?.embeddingProvider ?? '',
      embeddingModel: meta?.embeddingModel ?? '',
      distanceMetric: meta?.distanceMetric ?? 'cosine',
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      await this.#request('GET', '/collections');
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  override async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    const name = this.#name(collection);
    for (const batch of batches(documents, PAGE)) {
      await this.#request('PUT', `/collections/${enc(name)}/points?wait=true`, {
        points: batch.map((doc) => {
          const record = toChunkRecord(doc);
          return {
            id: chunkUuid(doc.id),
            vector: {
              [DENSE]: doc.vector,
              [SPARSE]: bm25DocumentVector(`${record.title} ${record.content}`),
            },
            payload: record,
          };
        }),
      });
    }
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#request(
      'POST',
      `/collections/${enc(this.#name(collection))}/points/delete?wait=true`,
      {
        points: ids.map(chunkUuid),
      },
    );
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the filter has no active fields.
   */
  override async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    requireActiveFilter(filter, 'delete');
    const name = this.#name(collection);
    const qFilter = buildFilter(filter);
    const count = await this.#request<{ result: { count: number } }>(
      'POST',
      `/collections/${enc(name)}/points/count`,
      { filter: qFilter, exact: true },
    );
    await this.#request('POST', `/collections/${enc(name)}/points/delete?wait=true`, {
      filter: qFilter,
    });
    return { removed: count.result.count };
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the filter has no active fields.
   */
  override async updateDocumentsMetadata(
    collection: string,
    filter: RAGFilter,
    patch: Partial<DocumentMetadata>,
  ): Promise<{ updated: number }> {
    requireActiveFilter(filter, 'update');
    const fields = toChunkPatch(patch);
    if (Object.keys(fields).length === 0) return { updated: 0 };
    const name = this.#name(collection);
    // Snapshot the matching points first: the patch may change the fields the
    // filter reads, and the result must count what matched before the update.
    const pointIds = (await this.#scroll(name, buildFilter(filter), false)).map((p) => p.id);
    for (const batch of batches(pointIds, 1000)) {
      await this.#request('POST', `/collections/${enc(name)}/points/payload?wait=true`, {
        payload: fields,
        points: batch,
      });
    }
    return { updated: pointIds.length };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const points = await this.#scroll(this.#name(collection), undefined, ['documentId']);
    const ids = new Set<string>();
    for (const p of points) {
      const id = p.payload?.documentId;
      if (id !== undefined && id !== '') ids.add(id);
    }
    return [...ids];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /** Dense vector search. */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const metric = await this.#metric(collection);
    const points = await this.#query(collection, vector, DENSE, topK, filter);
    return points.map((p) =>
      toPassage(p.payload ?? {}, collection, vectorScore(metric, p.score ?? 0)),
    );
  }

  /** BM25 keyword search over the sparse `text` vector. */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const sparse = bm25QueryVector(query);
    if (sparse.indices.length === 0) return [];
    const points = await this.#query(collection, sparse, SPARSE, topK, filter);
    return scaleByMax(points.map((p) => toPassage(p.payload ?? {}, collection, p.score ?? 0)));
  }

  /** Hybrid search: dense and BM25 rankings fused with Reciprocal Rank Fusion. */
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

  #name(collection: string): string {
    const name = `${this.#prefix}${collection}`;
    if (collection === '' || name === this.#metaCollection) {
      throw new RAGError(`qdrant: '${collection}' is not a valid collection name`, 'collection');
    }
    return name;
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.#http, method, path, body);
  }

  async #exists(name: string): Promise<boolean> {
    const res = await this.#request<{ result: { exists: boolean } }>(
      'GET',
      `/collections/${enc(name)}/exists`,
    );
    return res.result.exists;
  }

  async #createIndex(name: string, field: string, schema: 'keyword' | 'integer'): Promise<void> {
    await this.#request('PUT', `/collections/${enc(name)}/index?wait=true`, {
      field_name: field,
      field_schema: schema,
    });
  }

  async #ensureMetaCollection(): Promise<void> {
    if (await this.#exists(this.#metaCollection)) return;
    await this.#request('PUT', `/collections/${enc(this.#metaCollection)}`, {
      vectors: { meta: { size: 1, distance: 'Dot' } },
    });
  }

  async #meta(collection: string): Promise<
    | {
        embeddingProvider: string;
        embeddingModel: string;
        dimensions: number;
        distanceMetric: CollectionConfig['distanceMetric'];
      }
    | undefined
  > {
    if (!(await this.#exists(this.#metaCollection))) return undefined;
    const res = await this.#request<{ result: { payload?: Record<string, unknown> }[] }>(
      'POST',
      `/collections/${enc(this.#metaCollection)}/points`,
      { ids: [chunkUuid(collection)], with_payload: true },
    );
    const payload = res.result[0]?.payload;
    if (payload === undefined) return undefined;
    return {
      embeddingProvider: str(payload['embeddingProvider']),
      embeddingModel: str(payload['embeddingModel']),
      dimensions: Number(payload['dimensions'] ?? 0),
      distanceMetric: (payload['distanceMetric'] as CollectionConfig['distanceMetric']) ?? 'cosine',
    };
  }

  async #metric(collection: string): Promise<CollectionConfig['distanceMetric']> {
    const cached = this.#metrics.get(collection);
    if (cached !== undefined) return cached;
    const metric = (await this.#meta(collection))?.distanceMetric ?? 'cosine';
    this.#metrics.set(collection, metric);
    return metric;
  }

  async #query(
    collection: string,
    query: number[] | { indices: number[]; values: number[] },
    using: string,
    limit: number,
    filter: RAGFilter | undefined,
  ): Promise<QdrantPoint[]> {
    const qFilter = buildFilter(filter);
    const res = await this.#request<{ result: { points: QdrantPoint[] } }>(
      'POST',
      `/collections/${enc(this.#name(collection))}/points/query`,
      {
        query,
        using,
        limit,
        with_payload: true,
        ...(qFilter !== undefined && { filter: qFilter }),
      },
    );
    return res.result.points;
  }

  /** Iterates every point matching `filter` (all points when undefined). */
  async #scroll(
    name: string,
    filter: QdrantFilter | undefined,
    withPayload: boolean | string[],
  ): Promise<QdrantPoint[]> {
    const out: QdrantPoint[] = [];
    let offset: string | number | null | undefined;
    do {
      const res = await this.#request<{
        result: { points: QdrantPoint[]; next_page_offset?: string | number | null };
      }>('POST', `/collections/${enc(name)}/points/scroll`, {
        limit: 1000,
        with_payload: withPayload,
        with_vector: false,
        ...(filter !== undefined && { filter }),
        ...(offset !== undefined && offset !== null && { offset }),
      });
      out.push(...res.result.points);
      offset = res.result.next_page_offset;
    } while (offset !== undefined && offset !== null);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function enc(name: string): string {
  return encodeURIComponent(name);
}

type QdrantCondition = Record<string, unknown>;
interface QdrantFilter {
  must: QdrantCondition[];
}

/** Translates a {@link RAGFilter} into a Qdrant filter (undefined when empty). */
function buildFilter(filter: RAGFilter | undefined): QdrantFilter | undefined {
  if (filter === undefined) return undefined;
  requireScalarMetadataFilter(filter, 'qdrant');
  const must: QdrantCondition[] = [];
  const match = (key: string, value: unknown): QdrantCondition => ({ key, match: { value } });
  if (filter.tenantId !== undefined && filter.tenantId !== '') {
    must.push(match('tenantId', filter.tenantId));
  }
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    must.push({
      should: [
        { is_empty: { key: 'accessRoles' } },
        { key: 'accessRoles', match: { any: visibleRoles(filter) } },
      ],
    });
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    must.push({ key: 'tags', match: { any: filter.tags } });
  }
  for (const tag of filter.tagsAll ?? []) must.push(match('tags', tag));
  if (filter.documentId !== undefined) {
    must.push({ key: 'documentId', match: { any: documentIdList(filter) } });
  }
  if (filter.language !== undefined && filter.language !== '') {
    must.push(match('language', filter.language));
  }
  if (filter.dateRange?.from !== undefined || filter.dateRange?.to !== undefined) {
    must.push({
      key: 'createdAt',
      range: {
        ...(filter.dateRange.from !== undefined && { gte: filter.dateRange.from.getTime() }),
        ...(filter.dateRange.to !== undefined && { lte: filter.dateRange.to.getTime() }),
      },
    });
  }
  for (const [key, value] of Object.entries(filter.metadata ?? {})) {
    must.push(match(`custom.${key}`, value));
  }
  return must.length > 0 ? { must } : undefined;
}
