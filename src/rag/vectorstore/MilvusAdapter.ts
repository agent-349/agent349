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

/** Configuration for {@link MilvusAdapter}. */
export interface MilvusConfig {
  /** Milvus / Zilliz Cloud endpoint. Default: `'http://localhost:19530'`. */
  url?: string;
  /** `user:password`, or a Zilliz Cloud API key. */
  token?: string;
  /** Database name. Default: `'default'`. */
  database?: string;
  /** Request timeout in milliseconds. Default: 15 000. */
  timeoutMs?: number;
  /** Prefix of every collection the adapter creates. Default: `''`. */
  collectionPrefix?: string;
  /**
   * Consistency level of the collections the adapter creates. `'Strong'`
   * (default) makes writes visible to the next search, like the other
   * adapters; `'Bounded'` trades that for throughput.
   */
  consistencyLevel?: 'Strong' | 'Bounded' | 'Session' | 'Eventually';
  /** Custom `fetch` implementation (testing, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
}

const PAGE = 1000;
const METRIC: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: 'COSINE',
  dot: 'IP',
  euclidean: 'L2',
};
const SCALAR_FIELDS = [
  'id',
  'content',
  'documentId',
  'title',
  'source',
  'mimeType',
  'tenantId',
  'accessRoles',
  'tags',
  'language',
  'author',
  'createdAt',
  'updatedAt',
  'chunkIndex',
  'totalChunks',
  'custom',
];

interface MilvusResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

type MilvusRow = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// MilvusAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by [Milvus](https://milvus.io) (2.5 or later) or
 * Zilliz Cloud, over the RESTful API v2.
 *
 * Each collection has a dense `FloatVector` field and a sparse field filled by
 * Milvus's built-in BM25 function from `content`, so keyword search is native
 * full-text BM25. Hybrid search fuses both rankings with RRF. Collection
 * metadata lives in `<collectionPrefix>agent349_collections`.
 *
 * Collection names may contain letters, digits, `_` and `-` (`-` is stored as
 * `_`), so `a-b` and `a_b` cannot coexist.
 *
 * No client library is needed: the adapter uses `fetch`.
 */
export class MilvusAdapter extends VectorStoreAdapter {
  override readonly name = 'milvus';

  readonly #http: HttpClientOptions;
  readonly #database: string;
  readonly #prefix: string;
  readonly #metaCollection: string;
  readonly #consistency: NonNullable<MilvusConfig['consistencyLevel']>;
  readonly #metrics = new Map<string, CollectionConfig['distanceMetric']>();

  constructor(config: MilvusConfig = {}) {
    super();
    this.#http = {
      baseUrl: `${trimBaseUrl(config.url ?? 'http://localhost:19530')}/v2/vectordb`,
      headers:
        config.token !== undefined && config.token !== ''
          ? { Authorization: `Bearer ${config.token}` }
          : {},
      timeoutMs: config.timeoutMs ?? 15_000,
      fetch: config.fetch ?? defaultFetch,
      adapter: 'milvus',
    };
    this.#database = config.database ?? 'default';
    this.#prefix = config.collectionPrefix ?? '';
    this.#metaCollection = `${this.#prefix}agent349_collections`;
    this.#consistency = config.consistencyLevel ?? 'Strong';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /** Creates the Milvus collection with its BM25 function and indexes, plus its metadata entry. */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    const name = this.#name(collection);
    if (!(await this.#has(name))) {
      const varchar = (fieldName: string, maxLength: number, extra: object = {}): object => ({
        fieldName,
        dataType: 'VarChar',
        elementTypeParams: { max_length: maxLength, ...extra },
      });
      const list = (fieldName: string): object => ({
        fieldName,
        dataType: 'Array',
        elementDataType: 'VarChar',
        elementTypeParams: { max_capacity: 256, max_length: 512 },
      });
      const int64 = (fieldName: string): object => ({ fieldName, dataType: 'Int64' });
      await this.#call('/collections/create', {
        collectionName: name,
        schema: {
          autoId: false,
          enableDynamicField: false,
          fields: [
            { ...varchar('id', 512), isPrimary: true },
            varchar('content', 65535, { enable_analyzer: true }),
            {
              fieldName: 'dense',
              dataType: 'FloatVector',
              elementTypeParams: { dim: config.dimensions },
            },
            { fieldName: 'sparse', dataType: 'SparseFloatVector' },
            varchar('documentId', 512),
            varchar('title', 4096),
            varchar('source', 4096),
            varchar('mimeType', 256),
            varchar('tenantId', 512),
            list('accessRoles'),
            list('tags'),
            varchar('language', 64),
            varchar('author', 1024),
            int64('createdAt'),
            int64('updatedAt'),
            int64('chunkIndex'),
            int64('totalChunks'),
            { fieldName: 'custom', dataType: 'JSON' },
          ],
          functions: [
            {
              name: 'content_bm25',
              type: 'BM25',
              inputFieldNames: ['content'],
              outputFieldNames: ['sparse'],
            },
          ],
        },
        indexParams: [
          {
            fieldName: 'dense',
            indexName: 'dense',
            metricType: METRIC[config.distanceMetric],
            indexType: 'AUTOINDEX',
          },
          {
            fieldName: 'sparse',
            indexName: 'sparse',
            metricType: 'BM25',
            indexType: 'SPARSE_INVERTED_INDEX',
          },
        ],
        params: { consistencyLevel: this.#consistency },
      });
    }
    await this.#ensureMetaCollection();
    await this.#call('/entities/upsert', {
      collectionName: this.#metaCollection,
      data: [
        {
          id: collection,
          vector: [1, 0],
          info: {
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

  /** Drops the collection and its metadata entry. A missing collection is a no-op. */
  override async deleteCollection(collection: string): Promise<void> {
    const name = this.#name(collection);
    if (await this.#has(name)) {
      await this.#call('/collections/drop', { collectionName: name });
    }
    if (await this.#has(this.#metaCollection)) {
      await this.#call('/entities/delete', {
        collectionName: this.#metaCollection,
        filter: `id in ${literal([collection])}`,
      });
    }
    this.#metrics.delete(collection);
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    return this.#has(this.#name(collection));
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const name = this.#name(collection);
    if (!(await this.#has(name))) {
      throw new RAGError(`milvus: collection '${collection}' does not exist`, 'collection');
    }
    const meta = await this.#meta(collection);
    return {
      name: collection,
      documentCount: await this.#count(name, 'id != ""'),
      dimensions: meta?.dimensions ?? 0,
      embeddingProvider: meta?.embeddingProvider ?? '',
      embeddingModel: meta?.embeddingModel ?? '',
      distanceMetric: meta?.distanceMetric ?? 'cosine',
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      await this.#call('/collections/list', {});
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
    for (const batch of batches(documents, 200)) {
      await this.#call('/entities/upsert', {
        collectionName: name,
        data: batch.map((doc) => ({ ...toChunkRecord(doc), dense: doc.vector })),
      });
    }
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    const name = this.#name(collection);
    for (const batch of batches(ids, PAGE)) {
      await this.#call('/entities/delete', {
        collectionName: name,
        filter: `id in ${literal(batch)}`,
      });
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
    requireActiveFilter(filter, 'delete');
    const name = this.#name(collection);
    const expr = buildExpr(filter)!;
    const removed = await this.#count(name, expr);
    await this.#call('/entities/delete', { collectionName: name, filter: expr });
    return { removed };
  }

  /**
   * @inheritdoc
   *
   * Milvus has no partial update: matching entities are read with their dense
   * vectors and written back with the patched fields. The BM25 sparse vector is
   * regenerated by Milvus from the unchanged content.
   *
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
    // Snapshot first: the patch may change fields the filter reads.
    const rows = await this.#scan(name, buildExpr(filter), [...SCALAR_FIELDS, 'dense']);
    for (const batch of batches(rows, 200)) {
      await this.#call('/entities/upsert', {
        collectionName: name,
        data: batch.map((row) => ({ ...toRecord(row), ...fields, dense: row['dense'] })),
      });
    }
    return { updated: rows.length };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const rows = await this.#scan(this.#name(collection), undefined, ['id', 'documentId']);
    const ids = new Set<string>();
    for (const row of rows) {
      const id = row['documentId'];
      if (typeof id === 'string' && id !== '') ids.add(id);
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
    const rows = await this.#search(collection, vector, 'dense', topK, filter);
    return rows.map((row) =>
      toPassage(toRecord(row), collection, vectorScore(metric, Number(row['distance'] ?? 0))),
    );
  }

  /** BM25 full-text search through the collection's BM25 function. */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    if (query.trim() === '') return [];
    const rows = await this.#search(collection, query, 'sparse', topK, filter, {
      metricType: 'BM25',
    });
    return scaleByMax(
      rows.map((row) => toPassage(toRecord(row), collection, Number(row['distance'] ?? 0))),
    );
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
    if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
      throw new RAGError(
        `milvus: collection name '${collection}' may only contain letters, digits, '_' and '-'`,
        'collection',
      );
    }
    const name = `${this.#prefix}${collection.replace(/-/g, '_')}`;
    if (name === this.#metaCollection) {
      throw new RAGError(`milvus: '${collection}' is a reserved collection name`, 'collection');
    }
    return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
  }

  /** POSTs to the REST v2 API; Milvus reports errors in the body with a non-zero `code`. */
  async #call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await requestJson<MilvusResponse<T>>(this.#http, 'POST', path, {
      dbName: this.#database,
      ...body,
    });
    if (res.code !== 0) {
      throw new RAGError(
        `milvus: ${path} failed (code ${res.code}): ${res.message ?? ''}`,
        'vectorStore',
      );
    }
    return res.data as T;
  }

  async #has(name: string): Promise<boolean> {
    const res = await this.#call<{ has: boolean }>('/collections/has', { collectionName: name });
    return res.has;
  }

  async #count(name: string, filter: string): Promise<number> {
    const rows = await this.#call<MilvusRow[]>('/entities/query', {
      collectionName: name,
      filter,
      outputFields: ['count(*)'],
    });
    return Number(rows[0]?.['count(*)'] ?? 0);
  }

  async #ensureMetaCollection(): Promise<void> {
    if (await this.#has(this.#metaCollection)) return;
    await this.#call('/collections/create', {
      collectionName: this.#metaCollection,
      schema: {
        autoId: false,
        enableDynamicField: false,
        fields: [
          {
            fieldName: 'id',
            dataType: 'VarChar',
            isPrimary: true,
            elementTypeParams: { max_length: 512 },
          },
          { fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: 2 } },
          { fieldName: 'info', dataType: 'JSON' },
        ],
      },
      indexParams: [
        { fieldName: 'vector', indexName: 'vector', metricType: 'IP', indexType: 'AUTOINDEX' },
      ],
      params: { consistencyLevel: 'Strong' },
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
    if (!(await this.#has(this.#metaCollection))) return undefined;
    const rows = await this.#call<MilvusRow[]>('/entities/query', {
      collectionName: this.#metaCollection,
      filter: `id in ${literal([collection])}`,
      outputFields: ['info'],
    });
    const info = parseJson(rows[0]?.['info']);
    if (Object.keys(info).length === 0) return undefined;
    return {
      embeddingProvider: str(info['embeddingProvider']),
      embeddingModel: str(info['embeddingModel']),
      dimensions: Number(info['dimensions'] ?? 0),
      distanceMetric: (info['distanceMetric'] as CollectionConfig['distanceMetric']) ?? 'cosine',
    };
  }

  async #metric(collection: string): Promise<CollectionConfig['distanceMetric']> {
    const cached = this.#metrics.get(collection);
    if (cached !== undefined) return cached;
    const metric = (await this.#meta(collection))?.distanceMetric ?? 'cosine';
    this.#metrics.set(collection, metric);
    return metric;
  }

  async #search(
    collection: string,
    data: number[] | string,
    annsField: 'dense' | 'sparse',
    limit: number,
    filter: RAGFilter | undefined,
    searchParams?: Record<string, unknown>,
  ): Promise<MilvusRow[]> {
    const expr = buildExpr(filter);
    return this.#call<MilvusRow[]>('/entities/search', {
      collectionName: this.#name(collection),
      data: [data],
      annsField,
      limit,
      outputFields: SCALAR_FIELDS,
      ...(expr !== undefined && { filter: expr }),
      ...(searchParams !== undefined && { searchParams }),
    });
  }

  /**
   * Reads every entity matching `expr`, paging by primary key: Milvus returns
   * query results ordered by primary key, so `id > last` resumes where the
   * previous page ended.
   */
  async #scan(
    name: string,
    expr: string | undefined,
    outputFields: string[],
  ): Promise<MilvusRow[]> {
    const out: MilvusRow[] = [];
    let last: string | undefined;
    for (;;) {
      const clauses = [expr ?? 'id != ""'];
      if (last !== undefined) clauses.push(`id > ${JSON.stringify(last)}`);
      const rows = await this.#call<MilvusRow[]>('/entities/query', {
        collectionName: name,
        filter: clauses.map((c) => `(${c})`).join(' and '),
        outputFields,
        limit: PAGE,
      });
      out.push(...rows);
      if (rows.length < PAGE) break;
      last = String(rows[rows.length - 1]!['id']);
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Milvus list literal of strings: `["a", "b"]` (JSON string escaping is valid). */
function literal(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

/** The REST API returns arrays either plainly or in their protobuf wrapper. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const wrapped = (value as { Data?: { StringData?: { data?: unknown[] } } } | null)?.Data
    ?.StringData?.data;
  return Array.isArray(wrapped) ? wrapped.map(String) : [];
}

/** JSON fields come back as strings; parse them defensively. */
function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value !== '') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toRecord(row: MilvusRow): ChunkRecord {
  return {
    id: str(row['id']),
    content: str(row['content']),
    documentId: str(row['documentId']),
    title: str(row['title']),
    source: str(row['source']),
    mimeType: str(row['mimeType']),
    tenantId: str(row['tenantId']),
    accessRoles: toStringArray(row['accessRoles']),
    tags: toStringArray(row['tags']),
    language: str(row['language']),
    author: str(row['author']),
    createdAt: Number(row['createdAt'] ?? 0),
    updatedAt: Number(row['updatedAt'] ?? 0),
    chunkIndex: Number(row['chunkIndex'] ?? 0),
    totalChunks: Number(row['totalChunks'] ?? 0),
    custom: parseJson(row['custom']),
  };
}

/** Translates a {@link RAGFilter} into a Milvus boolean expression (undefined when empty). */
function buildExpr(filter: RAGFilter | undefined): string | undefined {
  if (filter === undefined) return undefined;
  requireScalarMetadataFilter(filter, 'milvus');
  const clauses: string[] = [];
  if (filter.tenantId !== undefined && filter.tenantId !== '') {
    clauses.push(`tenantId == ${JSON.stringify(filter.tenantId)}`);
  }
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    clauses.push(
      `(array_length(accessRoles) == 0 or array_contains_any(accessRoles, ${literal(visibleRoles(filter))}))`,
    );
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    clauses.push(`array_contains_any(tags, ${literal(filter.tags)})`);
  }
  if (filter.tagsAll !== undefined && filter.tagsAll.length > 0) {
    clauses.push(`array_contains_all(tags, ${literal(filter.tagsAll)})`);
  }
  if (filter.documentId !== undefined) {
    clauses.push(`documentId in ${literal(documentIdList(filter))}`);
  }
  if (filter.language !== undefined && filter.language !== '') {
    clauses.push(`language == ${JSON.stringify(filter.language)}`);
  }
  if (filter.dateRange?.from !== undefined) {
    clauses.push(`createdAt >= ${filter.dateRange.from.getTime()}`);
  }
  if (filter.dateRange?.to !== undefined) {
    clauses.push(`createdAt <= ${filter.dateRange.to.getTime()}`);
  }
  for (const [key, value] of Object.entries(filter.metadata ?? {})) {
    clauses.push(`custom[${JSON.stringify(key)}] == ${JSON.stringify(value)}`);
  }
  return clauses.length > 0 ? clauses.join(' and ') : undefined;
}
