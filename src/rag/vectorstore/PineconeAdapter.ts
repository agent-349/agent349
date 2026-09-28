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
  documentIdList,
  matchesFilter,
  requestJson,
  requireActiveFilter,
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

/** Configuration for {@link PineconeAdapter}. */
export interface PineconeConfig {
  /** Pinecone API key. */
  apiKey?: string;
  /** Name of the index holding every collection (one namespace per collection). */
  indexName: string;
  /**
   * Create the index when it does not exist, as a serverless index in this
   * cloud and region, with the dimensions and metric of the first collection.
   * When omitted, the index must already exist.
   */
  createIndex?: { cloud: 'aws' | 'gcp' | 'azure'; region: string };
  /** Control-plane URL. Default: `'https://api.pinecone.io'` (use `http://localhost:5080` for Pinecone Local). */
  controlPlaneUrl?: string;
  /** Data-plane URL of the index. Default: discovered from the control plane. */
  indexHost?: string;
  /** Prefix of every namespace the adapter writes. Default: `''`. */
  namespacePrefix?: string;
  /** Value of the `X-Pinecone-API-Version` header. Default: `'2025-01'`. */
  apiVersion?: string;
  /** Request timeout in milliseconds. Default: 15 000. */
  timeoutMs?: number;
  /** Custom `fetch` implementation (testing, proxies). Default: global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Stored in `accessRoles` for chunks without roles: Pinecone can filter list
 * membership but not list emptiness, so public chunks carry this marker.
 */
const PUBLIC_MARKER = '__public__';
const META_NAMESPACE = '__agent349_collections';
const METRIC: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: 'cosine',
  dot: 'dotproduct',
  euclidean: 'euclidean',
};

type PineconeMetadata = Record<string, string | number | boolean | string[]>;

interface IndexDescription {
  host: string;
  dimension: number;
  metric: string;
  status?: { ready?: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// PineconeAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by [Pinecone](https://www.pinecone.io), over its
 * REST API.
 *
 * All collections share one index (`indexName`), one namespace per collection,
 * so the index's dimension and metric apply to every collection. Collection
 * metadata is kept in the `__agent349_collections` namespace. Chunk content and
 * metadata are stored as Pinecone metadata (40 KB per record).
 *
 * **Vector search only.** A dense Pinecone index has no keyword ranking, so
 * `keywordSearch()` and `hybridSearch()` throw; configure
 * `rag.retrieval.searchMode: "vector"`.
 *
 * Serverless indexes cannot delete or update by metadata filter, so
 * `removeDocumentsByFilter()`, `updateDocumentsMetadata()` and
 * `listDocumentIds()` enumerate the collection's namespace (list + fetch) and
 * evaluate the filter client-side. Their cost grows with the collection size.
 *
 * No client library is needed: the adapter uses `fetch`.
 */
export class PineconeAdapter extends VectorStoreAdapter {
  override readonly name = 'pinecone';

  readonly #config: PineconeConfig;
  readonly #control: HttpClientOptions;
  #data: HttpClientOptions | undefined;
  #index: IndexDescription | undefined;
  readonly #prefix: string;

  constructor(config: PineconeConfig) {
    super();
    if (config.indexName === undefined || config.indexName === '') {
      throw new RAGError('pinecone: indexName is required', 'indexName');
    }
    this.#config = config;
    this.#prefix = config.namespacePrefix ?? '';
    this.#control = {
      baseUrl: trimBaseUrl(config.controlPlaneUrl ?? 'https://api.pinecone.io'),
      headers: {
        'X-Pinecone-API-Version': config.apiVersion ?? '2025-01',
        ...(config.apiKey !== undefined && config.apiKey !== '' && { 'Api-Key': config.apiKey }),
      },
      timeoutMs: config.timeoutMs ?? 15_000,
      fetch: config.fetch ?? defaultFetch,
      adapter: 'pinecone',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a collection (namespace). The index is created first when
   * `createIndex` is configured and it does not exist.
   *
   * @throws {@link RAGError} when the index dimension or metric differs from the collection's.
   */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    const index = await this.#ensureIndex(config);
    if (index.dimension !== config.dimensions || index.metric !== METRIC[config.distanceMetric]) {
      throw new RAGError(
        `pinecone: index '${this.#config.indexName}' has dimension ${index.dimension} and metric ` +
          `'${index.metric}', but collection '${collection}' needs ${config.dimensions} and ` +
          `'${METRIC[config.distanceMetric]}'. One index serves every collection.`,
        'collection',
      );
    }
    await this.#dataCall('/vectors/upsert', {
      namespace: META_NAMESPACE,
      vectors: [
        {
          id: this.#namespace(collection),
          values: this.#probeVector(),
          metadata: {
            name: collection,
            embeddingProvider: config.embeddingProvider,
            embeddingModel: config.embeddingModel,
            dimensions: config.dimensions,
            distanceMetric: config.distanceMetric,
          },
        },
      ],
    });
  }

  /** Deletes every vector of the collection and its metadata record. A missing collection is a no-op. */
  override async deleteCollection(collection: string): Promise<void> {
    if (!(await this.collectionExists(collection))) return;
    const namespace = this.#namespace(collection);
    try {
      await this.#dataCall('/vectors/delete', { namespace, deleteAll: true });
    } catch (err) {
      // An empty namespace does not exist yet in Pinecone.
      if (!(err instanceof RAGError && /HTTP 404/.test(err.message))) throw err;
    }
    await this.#dataCall('/vectors/delete', { namespace: META_NAMESPACE, ids: [namespace] });
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    if (!(await this.#indexExists())) return false;
    return (await this.#meta(collection)) !== undefined;
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const meta = (await this.#indexExists()) ? await this.#meta(collection) : undefined;
    if (meta === undefined) {
      throw new RAGError(`pinecone: collection '${collection}' does not exist`, 'collection');
    }
    const stats = await this.#dataCall<{ namespaces?: Record<string, { vectorCount?: number }> }>(
      '/describe_index_stats',
      {},
    );
    return {
      name: collection,
      documentCount: stats.namespaces?.[this.#namespace(collection)]?.vectorCount ?? 0,
      dimensions: Number(meta['dimensions'] ?? 0),
      embeddingProvider: str(meta['embeddingProvider']),
      embeddingModel: str(meta['embeddingModel']),
      distanceMetric: (meta['distanceMetric'] as CollectionConfig['distanceMetric']) ?? 'cosine',
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      await requestJson(this.#control, 'GET', '/indexes');
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
    const namespace = this.#namespace(collection);
    for (const batch of batches(documents, 100)) {
      await this.#dataCall('/vectors/upsert', {
        namespace,
        vectors: batch.map((doc) => ({
          id: doc.id,
          values: doc.vector,
          metadata: toMetadata(toChunkRecord(doc)),
        })),
      });
    }
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    const namespace = this.#namespace(collection);
    for (const batch of batches(ids, 1000)) {
      await this.#dataCall('/vectors/delete', { namespace, ids: batch });
    }
  }

  /**
   * @inheritdoc
   *
   * Scans the namespace and deletes the matching chunks by ID.
   *
   * @throws {@link RAGError} when the filter has no active fields.
   */
  override async removeDocumentsByFilter(
    collection: string,
    filter: RAGFilter,
  ): Promise<{ removed: number }> {
    requireActiveFilter(filter, 'delete');
    const ids = (await this.#scan(collection))
      .filter((r) => matchesFilter(r, filter))
      .map((r) => r.id);
    await this.delete(collection, ids);
    return { removed: ids.length };
  }

  /**
   * @inheritdoc
   *
   * Scans the namespace and updates the matching chunks' metadata by ID.
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
    const setMetadata: PineconeMetadata = { ...fields } as PineconeMetadata;
    if (fields.accessRoles !== undefined)
      setMetadata['accessRoles'] = storedRoles(fields.accessRoles);
    const namespace = this.#namespace(collection);
    const targets = (await this.#scan(collection)).filter((r) => matchesFilter(r, filter));
    for (const record of targets) {
      await this.#dataCall('/vectors/update', { namespace, id: record.id, setMetadata });
    }
    return { updated: targets.length };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of await this.#scan(collection)) {
      if (record.documentId !== '') ids.add(record.documentId);
    }
    return [...ids];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /** Dense vector search in the collection's namespace. */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const index = await this.#describeIndex();
    const metric = metricOf(index.metric);
    const pFilter = buildFilter(filter);
    const res = await this.#dataCall<{
      matches?: { id: string; score?: number; metadata?: Record<string, unknown> }[];
    }>('/query', {
      namespace: this.#namespace(collection),
      vector,
      topK,
      includeMetadata: true,
      ...(pFilter !== undefined && { filter: pFilter }),
    });
    return (res.matches ?? []).map((m) =>
      toPassage(
        fromMetadata(m.id, m.metadata ?? {}),
        collection,
        vectorScore(metric, m.score ?? 0),
      ),
    );
  }

  /**
   * Not supported: a dense Pinecone index has no keyword ranking.
   *
   * @throws {@link RAGError} always.
   */
  override async keywordSearch(): Promise<Passage[]> {
    throw unsupported('keyword');
  }

  /**
   * Not supported: a dense Pinecone index has no keyword ranking.
   *
   * @throws {@link RAGError} always.
   */
  override async hybridSearch(): Promise<Passage[]> {
    throw unsupported('hybrid');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #namespace(collection: string): string {
    if (collection === '') throw new RAGError('pinecone: collection name is empty', 'collection');
    const namespace = `${this.#prefix}${collection}`;
    if (namespace === META_NAMESPACE) {
      throw new RAGError(`pinecone: '${collection}' is a reserved collection name`, 'collection');
    }
    return namespace;
  }

  #probeVector(): number[] {
    const dims = this.#index?.dimension ?? 1;
    return Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
  }

  async #indexExists(): Promise<boolean> {
    try {
      await this.#describeIndex();
      return true;
    } catch (err) {
      if (err instanceof RAGError && /HTTP 404/.test(err.message)) return false;
      throw err;
    }
  }

  async #describeIndex(): Promise<IndexDescription> {
    if (this.#index !== undefined) return this.#index;
    const index = await requestJson<IndexDescription>(
      this.#control,
      'GET',
      `/indexes/${encodeURIComponent(this.#config.indexName)}`,
    );
    this.#index = index;
    return index;
  }

  async #ensureIndex(config: CollectionConfig): Promise<IndexDescription> {
    if (await this.#indexExists()) return this.#describeIndex();
    const spec = this.#config.createIndex;
    if (spec === undefined) {
      throw new RAGError(
        `pinecone: index '${this.#config.indexName}' does not exist. Create it, or set createIndex.`,
        'indexName',
      );
    }
    await requestJson(this.#control, 'POST', '/indexes', {
      name: this.#config.indexName,
      dimension: config.dimensions,
      metric: METRIC[config.distanceMetric],
      spec: { serverless: { cloud: spec.cloud, region: spec.region } },
    });
    // Serverless indexes take a few seconds to become ready.
    for (let attempt = 0; attempt < 60; attempt++) {
      this.#index = undefined;
      const index = await this.#describeIndex();
      if (index.status?.ready !== false) return index;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new RAGError(
      `pinecone: index '${this.#config.indexName}' did not become ready`,
      'indexName',
    );
  }

  async #dataClient(): Promise<HttpClientOptions> {
    if (this.#data !== undefined) return this.#data;
    let host = this.#config.indexHost;
    if (host === undefined) {
      const described = (await this.#describeIndex()).host;
      const scheme = this.#control.baseUrl.startsWith('http://') ? 'http' : 'https';
      host = /^https?:\/\//.test(described) ? described : `${scheme}://${described}`;
    }
    this.#data = { ...this.#control, baseUrl: trimBaseUrl(host) };
    return this.#data;
  }

  async #dataCall<T>(path: string, body: unknown): Promise<T> {
    await this.#describeIndex();
    return requestJson<T>(await this.#dataClient(), 'POST', path, body);
  }

  async #meta(collection: string): Promise<Record<string, unknown> | undefined> {
    const client = await this.#dataClient();
    const id = encodeURIComponent(this.#namespace(collection));
    const res = await requestJson<{
      vectors?: Record<string, { metadata?: Record<string, unknown> }>;
    }>(client, 'GET', `/vectors/fetch?namespace=${encodeURIComponent(META_NAMESPACE)}&ids=${id}`);
    return res.vectors?.[this.#namespace(collection)]?.metadata;
  }

  /** Reads every record of the collection's namespace (IDs via list, metadata via fetch). */
  async #scan(collection: string): Promise<ChunkRecord[]> {
    const client = await this.#dataClient();
    const namespace = encodeURIComponent(this.#namespace(collection));
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const page = await requestJson<{
        vectors?: { id: string }[];
        pagination?: { next?: string };
      }>(
        client,
        'GET',
        `/vectors/list?namespace=${namespace}&limit=100` +
          (token !== undefined ? `&paginationToken=${encodeURIComponent(token)}` : ''),
      );
      for (const v of page.vectors ?? []) ids.push(v.id);
      token = page.pagination?.next;
    } while (token !== undefined && token !== '');

    const records: ChunkRecord[] = [];
    for (const batch of batches(ids, 100)) {
      const query = batch.map((id) => `ids=${encodeURIComponent(id)}`).join('&');
      const res = await requestJson<{
        vectors?: Record<string, { id: string; metadata?: Record<string, unknown> }>;
      }>(client, 'GET', `/vectors/fetch?namespace=${namespace}&${query}`);
      for (const v of Object.values(res.vectors ?? {})) {
        records.push(fromMetadata(v.id, v.metadata ?? {}));
      }
    }
    return records;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function unsupported(kind: 'keyword' | 'hybrid'): RAGError {
  return new RAGError(
    `pinecone: ${kind} search is not supported (a dense Pinecone index has no keyword ranking). ` +
      'Set rag.retrieval.searchMode to "vector", and pass searchMode: "vector" in direct ' +
      'orch.rag.search() queries.',
    'searchMode',
  );
}

function metricOf(metric: string): CollectionConfig['distanceMetric'] {
  if (metric === 'dotproduct') return 'dot';
  if (metric === 'euclidean') return 'euclidean';
  return 'cosine';
}

function storedRoles(roles: string[]): string[] {
  return roles.length > 0 ? roles : [PUBLIC_MARKER];
}

function toMetadata(record: ChunkRecord): PineconeMetadata {
  const { id: _id, custom, accessRoles, ...rest } = record;
  return { ...rest, accessRoles: storedRoles(accessRoles), custom: JSON.stringify(custom) };
}

function fromMetadata(id: string, meta: Record<string, unknown>): ChunkRecord {
  let custom: Record<string, unknown> = {};
  if (typeof meta['custom'] === 'string' && meta['custom'] !== '') {
    try {
      custom = JSON.parse(meta['custom']) as Record<string, unknown>;
    } catch {
      custom = {};
    }
  }
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  return {
    id,
    content: str(meta['content']),
    documentId: str(meta['documentId']),
    title: str(meta['title']),
    source: str(meta['source']),
    mimeType: str(meta['mimeType']),
    tenantId: str(meta['tenantId']),
    accessRoles: list(meta['accessRoles']).filter((r) => r !== PUBLIC_MARKER),
    tags: list(meta['tags']),
    language: str(meta['language']),
    author: str(meta['author']),
    createdAt: Number(meta['createdAt'] ?? 0),
    updatedAt: Number(meta['updatedAt'] ?? 0),
    chunkIndex: Number(meta['chunkIndex'] ?? 0),
    totalChunks: Number(meta['totalChunks'] ?? 0),
    custom,
  };
}

/** Translates a {@link RAGFilter} into a Pinecone metadata filter (undefined when empty). */
function buildFilter(filter: RAGFilter | undefined): Record<string, unknown> | undefined {
  if (filter === undefined) return undefined;
  if (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0) {
    throw new RAGError(
      'pinecone: filter.metadata is not supported (custom metadata is stored as JSON text)',
      'filter.metadata',
    );
  }
  const and: Record<string, unknown>[] = [];
  if (filter.tenantId !== undefined && filter.tenantId !== '') {
    and.push({ tenantId: { $eq: filter.tenantId } });
  }
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    and.push({ accessRoles: { $in: [...visibleRoles(filter), PUBLIC_MARKER] } });
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    and.push({ tags: { $in: filter.tags } });
  }
  for (const tag of filter.tagsAll ?? []) and.push({ tags: { $in: [tag] } });
  if (filter.documentId !== undefined) {
    and.push({ documentId: { $in: documentIdList(filter) } });
  }
  if (filter.language !== undefined && filter.language !== '') {
    and.push({ language: { $eq: filter.language } });
  }
  if (filter.dateRange?.from !== undefined) {
    and.push({ createdAt: { $gte: filter.dateRange.from.getTime() } });
  }
  if (filter.dateRange?.to !== undefined) {
    and.push({ createdAt: { $lte: filter.dateRange.to.getTime() } });
  }
  if (and.length === 0) return undefined;
  return and.length === 1 ? and[0] : { $and: and };
}
