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
import {
  batches,
  chunkUuid,
  documentIdList,
  matchesFilter,
  requestJson,
  requireActiveFilter,
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

/** Configuration for {@link WeaviateAdapter}. */
export interface WeaviateConfig {
  /** Weaviate REST endpoint. Default: `'http://localhost:8080'`. */
  url?: string;
  /** API key, sent as a bearer token (Weaviate Cloud or API-key auth). */
  apiKey?: string;
  /** Extra headers (e.g. a custom auth scheme). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Default: 10 000. */
  timeoutMs?: number;
  /**
   * Prefix of every collection (Weaviate class) the adapter creates. Must start
   * with an uppercase letter. Default: `'Agent349_'`.
   */
  classPrefix?: string;
  /** Custom `fetch` implementation (testing, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
}

const PAGE = 500;
const DISTANCE: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: 'cosine',
  dot: 'dot',
  euclidean: 'l2-squared',
};
const RETURN_FIELDS =
  'chunkId content documentId title source mimeType tenantId accessRoles tags language ' +
  'author createdAt updatedAt chunkIndex totalChunks custom';

/** Stored properties: a {@link ChunkRecord} with the chunk ID renamed and `custom` as JSON text. */
type WeaviateProperties = Omit<ChunkRecord, 'id' | 'custom'> & { chunkId: string; custom: string };

// ─────────────────────────────────────────────────────────────────────────────
// WeaviateAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by [Weaviate](https://weaviate.io), over its REST
 * and GraphQL APIs.
 *
 * Each SDK collection is a Weaviate collection (class) named
 * `<classPrefix><collection>`, with vectors supplied by the SDK
 * (`vectorizer: none`). Keyword search uses Weaviate's BM25 and hybrid search
 * its native fusion, where `alpha` has the same meaning as in the SDK.
 * Object IDs are deterministic UUIDs derived from chunk IDs. Collection
 * metadata lives in the `<classPrefix>Collections` class.
 *
 * Collection names may contain letters, digits, `_` and `-` (`-` is stored as
 * `_`), so `a-b` and `a_b` cannot coexist. Custom metadata (`metadata.custom`)
 * is stored but not filterable: a `filter.metadata` is rejected.
 *
 * No client library is needed: the adapter uses `fetch`.
 */
export class WeaviateAdapter extends VectorStoreAdapter {
  override readonly name = 'weaviate';

  readonly #http: HttpClientOptions;
  readonly #prefix: string;
  readonly #metaClass: string;
  readonly #metrics = new Map<string, CollectionConfig['distanceMetric']>();

  constructor(config: WeaviateConfig = {}) {
    super();
    const prefix = config.classPrefix ?? 'Agent349_';
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(prefix)) {
      throw new RAGError(
        `weaviate: classPrefix '${prefix}' must start with an uppercase letter and contain only letters, digits and '_'`,
        'classPrefix',
      );
    }
    this.#prefix = prefix;
    this.#metaClass = `${prefix}Collections`;
    this.#http = {
      baseUrl: trimBaseUrl(config.url ?? 'http://localhost:8080'),
      headers: {
        ...(config.apiKey !== undefined &&
          config.apiKey !== '' && {
            Authorization: `Bearer ${config.apiKey}`,
          }),
        ...config.headers,
      },
      timeoutMs: config.timeoutMs ?? 10_000,
      fetch: config.fetch ?? defaultFetch,
      adapter: 'weaviate',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /** Creates the Weaviate class and its metadata object. An existing class is kept. */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    const cls = this.#className(collection);
    if (!(await this.#classExists(cls))) {
      const text = (name: string, tokenization: 'word' | 'field', searchable = true): object => ({
        name,
        dataType: ['text'],
        tokenization,
        indexSearchable: searchable,
      });
      const list = (name: string): object => ({
        name,
        dataType: ['text[]'],
        tokenization: 'field',
      });
      const num = (name: string): object => ({ name, dataType: ['number'] });
      await this.#request('POST', '/v1/schema', {
        class: cls,
        vectorizer: 'none',
        vectorIndexConfig: { distance: DISTANCE[config.distanceMetric] },
        // Empty arrays count as null, which is how public chunks (no roles) are
        // matched. Stop words are off: Weaviate applies them to filters too, and
        // a tag or role such as "it" or "a" must match exactly.
        invertedIndexConfig: { indexNullState: true, stopwords: { preset: 'none' } },
        properties: [
          text('content', 'word'),
          text('title', 'word'),
          text('chunkId', 'field', false),
          text('documentId', 'field', false),
          text('source', 'field', false),
          text('mimeType', 'field', false),
          text('tenantId', 'field', false),
          text('language', 'field', false),
          text('author', 'field', false),
          list('accessRoles'),
          list('tags'),
          num('createdAt'),
          num('updatedAt'),
          num('chunkIndex'),
          num('totalChunks'),
          { name: 'custom', dataType: ['text'], indexFilterable: false, indexSearchable: false },
        ],
      });
    }
    await this.#ensureMetaClass();
    await this.#batchPut([
      {
        class: this.#metaClass,
        id: chunkUuid(collection),
        properties: {
          name: collection,
          embeddingProvider: config.embeddingProvider,
          embeddingModel: config.embeddingModel,
          dimensions: config.dimensions,
          distanceMetric: config.distanceMetric,
        },
      },
    ]);
    this.#metrics.set(collection, config.distanceMetric);
  }

  /** Deletes the class and its metadata object. A missing collection is a no-op. */
  override async deleteCollection(collection: string): Promise<void> {
    const cls = this.#className(collection);
    if (await this.#classExists(cls)) {
      await this.#request('DELETE', `/v1/schema/${cls}`);
    }
    if (await this.#classExists(this.#metaClass)) {
      await this.#deleteObject(this.#metaClass, chunkUuid(collection));
    }
    this.#metrics.delete(collection);
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    return this.#classExists(this.#className(collection));
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const cls = this.#className(collection);
    if (!(await this.#classExists(cls))) {
      throw new RAGError(`weaviate: collection '${collection}' does not exist`, 'collection');
    }
    const agg = await this.#graphql<{ Aggregate: Record<string, { meta: { count: number } }[]> }>(
      `{ Aggregate { ${cls} { meta { count } } } }`,
    );
    const meta = await this.#meta(collection);
    return {
      name: collection,
      documentCount: agg.Aggregate[cls]?.[0]?.meta.count ?? 0,
      dimensions: meta?.dimensions ?? 0,
      embeddingProvider: meta?.embeddingProvider ?? '',
      embeddingModel: meta?.embeddingModel ?? '',
      distanceMetric: meta?.distanceMetric ?? 'cosine',
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      await this.#request('GET', '/v1/meta');
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
    const cls = this.#className(collection);
    for (const batch of batches(documents, 100)) {
      await this.#batchPut(
        batch.map((doc) => ({
          class: cls,
          id: chunkUuid(doc.id),
          vector: doc.vector,
          properties: toProperties(toChunkRecord(doc)),
        })),
      );
    }
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    const cls = this.#className(collection);
    for (const batch of batches(ids, PAGE)) {
      await this.#batchDelete(cls, {
        path: ['chunkId'],
        operator: enumValue('ContainsAny'),
        valueText: batch,
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
    const where = buildWhere(filter);
    let removed = 0;
    // Weaviate deletes at most QUERY_MAXIMUM_RESULTS objects per call.
    for (;;) {
      const matched = await this.#batchDelete(this.#className(collection), where!);
      removed += matched;
      if (matched === 0) break;
    }
    return { removed };
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
    const cls = this.#className(collection);
    // Snapshot every matching object before patching: a patch can change the
    // fields the filter reads, which would shift offset-based pagination.
    const targets = (await this.#scan(cls)).filter((r) => matchesFilter(r.record, filter));
    for (const { uuid } of targets) {
      await this.#request('PATCH', `/v1/objects/${cls}/${uuid}`, {
        class: cls,
        properties: fields,
      });
    }
    return { updated: targets.length };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const { record } of await this.#scan(this.#className(collection))) {
      if (record.documentId !== '') ids.add(record.documentId);
    }
    return [...ids];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /** Vector search (`nearVector`). */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const metric = await this.#metric(collection);
    const rows = await this.#get(
      collection,
      `nearVector: { vector: ${JSON.stringify(vector)} }`,
      topK,
      filter,
      'distance',
    );
    return rows.map((row) =>
      toPassage(
        fromProperties(row),
        collection,
        vectorScore(metric, similarity(metric, row._additional.distance)),
      ),
    );
  }

  /** BM25 keyword search over `content` and `title`. */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    if (query.trim() === '') return [];
    const rows = await this.#get(
      collection,
      `bm25: { query: ${JSON.stringify(query)}, properties: ["content", "title"] }`,
      topK,
      filter,
      'score',
    );
    return scaleByMax(
      rows.map((row) =>
        toPassage(fromProperties(row), collection, Number(row._additional.score ?? 0)),
      ),
    );
  }

  /** Native hybrid search (relative score fusion); `alpha` = 1 is pure vector. */
  override async hybridSearch(
    collection: string,
    vector: number[],
    query: string,
    topK: number,
    alpha: number,
    filter?: RAGFilter,
    _rrfK?: number,
  ): Promise<Passage[]> {
    const rows = await this.#get(
      collection,
      `hybrid: { query: ${JSON.stringify(query)}, vector: ${JSON.stringify(vector)}, alpha: ${alpha}, ` +
        'properties: ["content", "title"], fusionType: relativeScoreFusion }',
      topK,
      filter,
      'score',
    );
    return rows.map((row) =>
      toPassage(
        fromProperties(row),
        collection,
        Math.min(1, Math.max(0, Number(row._additional.score ?? 0))),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #className(collection: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
      throw new RAGError(
        `weaviate: collection name '${collection}' may only contain letters, digits, '_' and '-'`,
        'collection',
      );
    }
    const cls = `${this.#prefix}${collection.replace(/-/g, '_')}`;
    if (cls === this.#metaClass) {
      throw new RAGError(`weaviate: '${collection}' is a reserved collection name`, 'collection');
    }
    return cls;
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.#http, method, path, body);
  }

  async #graphql<T>(query: string): Promise<T> {
    const res = await this.#request<{ data?: T; errors?: { message: string }[] }>(
      'POST',
      '/v1/graphql',
      {
        query,
      },
    );
    if (res.errors !== undefined && res.errors.length > 0) {
      throw new RAGError(
        `weaviate: GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`,
        'vectorStore',
      );
    }
    return res.data as T;
  }

  async #classExists(cls: string): Promise<boolean> {
    try {
      await this.#request('GET', `/v1/schema/${cls}`);
      return true;
    } catch (err) {
      if (err instanceof RAGError && /HTTP 404/.test(err.message)) return false;
      throw err;
    }
  }

  async #ensureMetaClass(): Promise<void> {
    if (await this.#classExists(this.#metaClass)) return;
    await this.#request('POST', '/v1/schema', {
      class: this.#metaClass,
      vectorizer: 'none',
      properties: [
        { name: 'name', dataType: ['text'], tokenization: 'field' },
        { name: 'embeddingProvider', dataType: ['text'], tokenization: 'field' },
        { name: 'embeddingModel', dataType: ['text'], tokenization: 'field' },
        { name: 'dimensions', dataType: ['number'] },
        { name: 'distanceMetric', dataType: ['text'], tokenization: 'field' },
      ],
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
    try {
      const obj = await this.#request<{ properties: Record<string, unknown> }>(
        'GET',
        `/v1/objects/${this.#metaClass}/${chunkUuid(collection)}`,
      );
      return {
        embeddingProvider: str(obj.properties['embeddingProvider']),
        embeddingModel: str(obj.properties['embeddingModel']),
        dimensions: Number(obj.properties['dimensions'] ?? 0),
        distanceMetric:
          (obj.properties['distanceMetric'] as CollectionConfig['distanceMetric']) ?? 'cosine',
      };
    } catch (err) {
      if (err instanceof RAGError && /HTTP 404/.test(err.message)) return undefined;
      throw err;
    }
  }

  async #metric(collection: string): Promise<CollectionConfig['distanceMetric']> {
    const cached = this.#metrics.get(collection);
    if (cached !== undefined) return cached;
    const metric = (await this.#meta(collection))?.distanceMetric ?? 'cosine';
    this.#metrics.set(collection, metric);
    return metric;
  }

  async #batchPut(objects: object[]): Promise<void> {
    const results = await this.#request<
      { result?: { errors?: { error?: { message: string }[] } } }[]
    >('POST', '/v1/batch/objects', { objects });
    const errors = results.flatMap((r) => r.result?.errors?.error ?? []).map((e) => e.message);
    if (errors.length > 0) {
      throw new RAGError(
        `weaviate: batch write failed: ${errors.slice(0, 3).join('; ')}`,
        'vectorStore',
      );
    }
  }

  /** Deletes the objects matching `where`; returns how many matched. */
  async #batchDelete(cls: string, where: GraphQLValue): Promise<number> {
    const res = await this.#request<{ results?: { matches?: number; failed?: number } }>(
      'DELETE',
      '/v1/batch/objects',
      { match: { class: cls, where: toRestWhere(where) }, output: 'minimal' },
    );
    if ((res.results?.failed ?? 0) > 0) {
      throw new RAGError(
        `weaviate: ${res.results!.failed} objects could not be deleted`,
        'vectorStore',
      );
    }
    return res.results?.matches ?? 0;
  }

  async #deleteObject(cls: string, uuid: string): Promise<void> {
    try {
      await this.#request('DELETE', `/v1/objects/${cls}/${uuid}`);
    } catch (err) {
      if (!(err instanceof RAGError && /HTTP 404/.test(err.message))) throw err;
    }
  }

  async #get(
    collection: string,
    operator: string,
    limit: number,
    filter: RAGFilter | undefined,
    additional: 'distance' | 'score',
  ): Promise<WeaviateRow[]> {
    const cls = this.#className(collection);
    const where = buildWhere(filter);
    const args = [operator, `limit: ${Math.trunc(limit)}`];
    if (where !== undefined) args.push(`where: ${toGraphQL(where)}`);
    const data = await this.#graphql<{ Get: Record<string, WeaviateRow[] | null> }>(
      `{ Get { ${cls}(${args.join(', ')}) { ${RETURN_FIELDS} _additional { id ${additional} } } } }`,
    );
    return data.Get[cls] ?? [];
  }

  /** Reads every object of a class with the cursor API. */
  async #scan(cls: string): Promise<{ uuid: string; record: ChunkRecord }[]> {
    const out: { uuid: string; record: ChunkRecord }[] = [];
    let after: string | undefined;
    for (;;) {
      const cursor = after !== undefined ? `, after: ${JSON.stringify(after)}` : '';
      const data = await this.#graphql<{ Get: Record<string, WeaviateRow[] | null> }>(
        `{ Get { ${cls}(limit: ${PAGE}${cursor}) { ${RETURN_FIELDS} _additional { id } } } }`,
      );
      const rows = data.Get[cls] ?? [];
      for (const row of rows) {
        const record = fromProperties(row);
        out.push({ uuid: row._additional.id, record: { ...emptyRecord(), ...record } });
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1]!._additional.id;
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

interface WeaviateRow extends Partial<Omit<WeaviateProperties, 'custom'>> {
  custom?: string | null;
  _additional: { id: string; distance?: number; score?: string | number };
}

function toProperties(record: ChunkRecord): WeaviateProperties {
  const { id, custom, ...rest } = record;
  return { ...rest, chunkId: id, custom: JSON.stringify(custom) };
}

function fromProperties(row: WeaviateRow): Partial<ChunkRecord> {
  let custom: Record<string, unknown> = {};
  if (typeof row.custom === 'string' && row.custom !== '') {
    try {
      custom = JSON.parse(row.custom) as Record<string, unknown>;
    } catch {
      custom = {};
    }
  }
  return {
    id: row.chunkId ?? '',
    content: row.content ?? '',
    documentId: row.documentId ?? '',
    title: row.title ?? '',
    source: row.source ?? '',
    mimeType: row.mimeType ?? '',
    tenantId: row.tenantId ?? '',
    accessRoles: row.accessRoles ?? [],
    tags: row.tags ?? [],
    language: row.language ?? '',
    author: row.author ?? '',
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    chunkIndex: Number(row.chunkIndex ?? 0),
    totalChunks: Number(row.totalChunks ?? 0),
    custom,
  };
}

function emptyRecord(): ChunkRecord {
  return {
    id: '',
    content: '',
    documentId: '',
    title: '',
    source: '',
    mimeType: '',
    tenantId: '',
    accessRoles: [],
    tags: [],
    language: '',
    author: '',
    createdAt: 0,
    updatedAt: 0,
    chunkIndex: 0,
    totalChunks: 0,
    custom: {},
  };
}

/** Weaviate reports distances; convert to the similarity {@link vectorScore} expects. */
function similarity(
  metric: CollectionConfig['distanceMetric'],
  distance: number | undefined,
): number {
  const d = Number(distance ?? 0);
  switch (metric) {
    case 'cosine':
      return 1 - d; // cosine distance = 1 - similarity
    case 'dot':
      return -d; // dot distance = -dot product
    case 'euclidean':
    default:
      return Math.sqrt(Math.max(0, d)); // l2-squared → L2 distance
  }
}

// GraphQL input values: plain JSON, except enum literals, which must be unquoted.
type GraphQLValue =
  | string
  | number
  | boolean
  | GraphQLEnum
  | GraphQLValue[]
  | { [key: string]: GraphQLValue };
interface GraphQLEnum {
  readonly __enum: string;
}

function enumValue(name: string): GraphQLEnum {
  return { __enum: name };
}

function isEnum(value: unknown): value is GraphQLEnum {
  return typeof value === 'object' && value !== null && '__enum' in value;
}

function toGraphQL(value: GraphQLValue): string {
  if (isEnum(value)) return value.__enum;
  if (Array.isArray(value)) return `[${value.map(toGraphQL).join(', ')}]`;
  if (typeof value === 'object') {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${toGraphQL(v)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(value);
}

/**
 * Same filter for the REST batch API, where enums are plain strings and list
 * operands go in `valueTextArray` instead of `valueText`.
 */
function toRestWhere(value: GraphQLValue): unknown {
  if (isEnum(value)) return value.__enum;
  if (Array.isArray(value)) return value.map(toRestWhere);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === 'valueText' && Array.isArray(v) ? 'valueTextArray' : k,
        toRestWhere(v),
      ]),
    );
  }
  return value;
}

/** Translates a {@link RAGFilter} into a Weaviate `where` filter (undefined when empty). */
function buildWhere(filter: RAGFilter | undefined): GraphQLValue | undefined {
  if (filter === undefined) return undefined;
  if (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0) {
    throw new RAGError(
      'weaviate: filter.metadata is not supported (custom metadata is stored but not indexed)',
      'filter.metadata',
    );
  }
  const operands: GraphQLValue[] = [];
  const cond = (
    path: string,
    operator: string,
    key: string,
    value: GraphQLValue,
  ): GraphQLValue => ({
    path: [path],
    operator: enumValue(operator),
    [key]: value,
  });
  if (filter.tenantId !== undefined && filter.tenantId !== '') {
    operands.push(cond('tenantId', 'Equal', 'valueText', filter.tenantId));
  }
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    operands.push({
      operator: enumValue('Or'),
      operands: [
        cond('accessRoles', 'IsNull', 'valueBoolean', true),
        cond('accessRoles', 'ContainsAny', 'valueText', visibleRoles(filter)),
      ],
    });
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    operands.push(cond('tags', 'ContainsAny', 'valueText', filter.tags));
  }
  if (filter.tagsAll !== undefined && filter.tagsAll.length > 0) {
    operands.push(cond('tags', 'ContainsAll', 'valueText', filter.tagsAll));
  }
  if (filter.documentId !== undefined) {
    operands.push(cond('documentId', 'ContainsAny', 'valueText', documentIdList(filter)));
  }
  if (filter.language !== undefined && filter.language !== '') {
    operands.push(cond('language', 'Equal', 'valueText', filter.language));
  }
  if (filter.dateRange?.from !== undefined) {
    operands.push(
      cond('createdAt', 'GreaterThanEqual', 'valueNumber', filter.dateRange.from.getTime()),
    );
  }
  if (filter.dateRange?.to !== undefined) {
    operands.push(cond('createdAt', 'LessThanEqual', 'valueNumber', filter.dateRange.to.getTime()));
  }
  if (operands.length === 0) return undefined;
  if (operands.length === 1) return operands[0];
  return { operator: enumValue('And'), operands };
}
