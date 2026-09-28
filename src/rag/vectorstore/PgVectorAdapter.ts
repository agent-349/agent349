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
  requireActiveFilter,
  requireScalarMetadataFilter,
  toChunkPatch,
  toChunkRecord,
  toPassage,
  vectorScore,
  visibleRoles,
  str,
} from './common.js';
import type { ChunkRecord } from './common.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of a `pg` pool this adapter needs. */
export interface PgVectorPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/**
 * Configuration for {@link PgVectorAdapter}.
 *
 * Connect with `connectionString` (or discrete `host`/`port`/… fields), or
 * inject an already-open `pool`. An injected pool is never closed by the adapter.
 */
export interface PgVectorConfig {
  /** PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/db`. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** TLS: `true`, or options passed to `pg` (e.g. `{ rejectUnauthorized: false }`). */
  ssl?: boolean | Record<string, unknown>;
  /** Maximum pool size. Default: 10. */
  maxConnections?: number;
  /** An existing `pg.Pool` (or compatible). Takes precedence over connection fields. */
  pool?: PgVectorPool;
  /** Schema holding the tables. Default: `'public'`. */
  schema?: string;
  /** Prefix of every table the adapter creates. Default: `'agent349_'`. */
  tablePrefix?: string;
  /**
   * PostgreSQL text-search configuration for keyword search (`'simple'`,
   * `'english'`, `'spanish'`, …). Fixed per collection at creation. Default: `'simple'`.
   */
  textSearchConfig?: string;
  /** Run `CREATE EXTENSION IF NOT EXISTS vector` when creating a collection. Default: `true`. */
  createExtension?: boolean;
}

// pgvector's HNSW index supports up to 2 000 dimensions for the `vector` type.
const HNSW_MAX_DIMENSIONS = 2000;
const UPSERT_BATCH = 500;
const COLUMNS =
  'id, content, document_id, title, source, mime_type, tenant_id, access_roles, tags, ' +
  'language, author, created_at, updated_at, chunk_index, total_chunks, custom';

const OPERATOR: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: '<=>',
  dot: '<#>',
  euclidean: '<->',
};
const OPCLASS: Record<CollectionConfig['distanceMetric'], string> = {
  cosine: 'vector_cosine_ops',
  dot: 'vector_ip_ops',
  euclidean: 'vector_l2_ops',
};

// ─────────────────────────────────────────────────────────────────────────────
// PgVectorAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vector store adapter backed by PostgreSQL with the
 * [pgvector](https://github.com/pgvector/pgvector) extension.
 *
 * Each collection is a table (`<tablePrefix><collection>`) with a `vector(n)`
 * column, an HNSW index for the configured distance metric (up to 2 000
 * dimensions; larger vectors are searched exactly), and a generated `tsvector`
 * column for PostgreSQL full-text search. Collection metadata lives in
 * `<tablePrefix>collections`. Hybrid search fuses both rankings with RRF.
 *
 * Requires the `pg` package (`npm install pg`), loaded on first use.
 *
 * @example
 * ```typescript
 * const store = new PgVectorAdapter({ connectionString: process.env.DATABASE_URL });
 * ```
 */
export class PgVectorAdapter extends VectorStoreAdapter {
  override readonly name = 'pgvector';

  readonly #config: PgVectorConfig;
  readonly #schema: string;
  readonly #prefix: string;
  #pool: PgVectorPool | undefined;
  #poolPromise: Promise<PgVectorPool> | undefined;
  readonly #ownsPool: boolean;
  readonly #metrics = new Map<string, CollectionConfig['distanceMetric']>();

  constructor(config: PgVectorConfig = {}) {
    super();
    this.#config = config;
    this.#schema = config.schema ?? 'public';
    this.#prefix = config.tablePrefix ?? 'agent349_';
    this.#pool = config.pool;
    this.#ownsPool = config.pool === undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates the collection table, its indexes and its metadata row. Idempotent:
   * an existing table is kept, and its metadata row is replaced.
   */
  override async createCollection(collection: string, config: CollectionConfig): Promise<void> {
    const pool = await this.#getPool();
    if (this.#config.createExtension !== false) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    }
    await this.#ensureMetaTable(pool);

    const table = this.#table(collection);
    const tsConfig = this.#config.textSearchConfig ?? 'simple';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tsConfig)) {
      throw new RAGError(`pgvector: invalid textSearchConfig '${tsConfig}'`, 'textSearchConfig');
    }
    const dims = Math.trunc(config.dimensions);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id text PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${dims}) NOT NULL,
        document_id text NOT NULL DEFAULT '',
        title text NOT NULL DEFAULT '',
        source text NOT NULL DEFAULT '',
        mime_type text NOT NULL DEFAULT '',
        tenant_id text NOT NULL DEFAULT '',
        access_roles text[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        language text NOT NULL DEFAULT '',
        author text NOT NULL DEFAULT '',
        created_at bigint NOT NULL DEFAULT 0,
        updated_at bigint NOT NULL DEFAULT 0,
        chunk_index integer NOT NULL DEFAULT 0,
        total_chunks integer NOT NULL DEFAULT 0,
        custom jsonb NOT NULL DEFAULT '{}',
        tsv tsvector GENERATED ALWAYS AS (
          to_tsvector('${tsConfig}', coalesce(title, '') || ' ' || content)
        ) STORED
      )`,
    );
    const base = this.#indexBase(collection);
    if (dims <= HNSW_MAX_DIMENSIONS) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${base}_hnsw`)} ON ${table} ` +
          `USING hnsw (embedding ${OPCLASS[config.distanceMetric]})`,
      );
    }
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${base}_tsv`)} ON ${table} USING gin (tsv)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${base}_doc`)} ON ${table} (tenant_id, document_id)`,
    );
    await pool.query(
      `INSERT INTO ${this.#metaTable()} (name, embedding_provider, embedding_model, dimensions, distance_metric)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET embedding_provider = EXCLUDED.embedding_provider,
         embedding_model = EXCLUDED.embedding_model, dimensions = EXCLUDED.dimensions,
         distance_metric = EXCLUDED.distance_metric`,
      [collection, config.embeddingProvider, config.embeddingModel, dims, config.distanceMetric],
    );
    this.#metrics.set(collection, config.distanceMetric);
  }

  /** Drops the collection table and its metadata row. A missing collection is a no-op. */
  override async deleteCollection(collection: string): Promise<void> {
    const pool = await this.#getPool();
    await pool.query(`DROP TABLE IF EXISTS ${this.#table(collection)}`);
    if (await this.#metaTableExists(pool)) {
      await pool.query(`DELETE FROM ${this.#metaTable()} WHERE name = $1`, [collection]);
    }
    this.#metrics.delete(collection);
  }

  /** @inheritdoc */
  override async collectionExists(collection: string): Promise<boolean> {
    const pool = await this.#getPool();
    const res = await pool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [
      this.#table(collection),
    ]);
    return res.rows[0]?.['exists'] === true;
  }

  /**
   * @inheritdoc
   * @throws {@link RAGError} when the collection does not exist.
   */
  override async collectionInfo(collection: string): Promise<CollectionInfo> {
    const pool = await this.#getPool();
    if (!(await this.collectionExists(collection))) {
      throw new RAGError(`pgvector: collection '${collection}' does not exist`, 'collection');
    }
    const count = await pool.query(`SELECT count(*)::bigint AS n FROM ${this.#table(collection)}`);
    const meta = (await this.#metaTableExists(pool))
      ? await pool.query(
          `SELECT embedding_provider, embedding_model, dimensions, distance_metric
             FROM ${this.#metaTable()} WHERE name = $1`,
          [collection],
        )
      : { rows: [] };
    const row = meta.rows[0];
    return {
      name: collection,
      documentCount: Number(count.rows[0]?.['n'] ?? 0),
      dimensions: Number(row?.['dimensions'] ?? 0),
      embeddingProvider: str(row?.['embedding_provider']),
      embeddingModel: str(row?.['embedding_model']),
      distanceMetric: (row?.['distance_metric'] as CollectionInfo['distanceMetric']) ?? 'cosine',
    };
  }

  /** @inheritdoc */
  override async healthCheck(): Promise<boolean> {
    try {
      const pool = await this.#getPool();
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the connection pool when the adapter created it. */
  override async close(): Promise<void> {
    if (this.#ownsPool && this.#pool !== undefined) {
      const pool = this.#pool;
      this.#pool = undefined;
      this.#poolPromise = undefined;
      await pool.end();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  override async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const pool = await this.#getPool();
    const table = this.#table(collection);
    for (const batch of batches(documents, UPSERT_BATCH)) {
      const values: unknown[] = [];
      const rows = batch.map((doc) => {
        const r = toChunkRecord(doc);
        const start = values.length;
        values.push(
          r.id,
          r.content,
          toVectorLiteral(doc.vector),
          r.documentId,
          r.title,
          r.source,
          r.mimeType,
          r.tenantId,
          r.accessRoles,
          r.tags,
          r.language,
          r.author,
          r.createdAt,
          r.updatedAt,
          r.chunkIndex,
          r.totalChunks,
          JSON.stringify(r.custom),
        );
        const p = (i: number): string => `$${start + i}`;
        return (
          `(${p(1)}, ${p(2)}, ${p(3)}::vector, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ` +
          `${p(9)}::text[], ${p(10)}::text[], ${p(11)}, ${p(12)}, ${p(13)}, ${p(14)}, ${p(15)}, ` +
          `${p(16)}, ${p(17)}::jsonb)`
        );
      });
      await pool.query(
        `INSERT INTO ${table} (id, content, embedding, document_id, title, source, mime_type,
           tenant_id, access_roles, tags, language, author, created_at, updated_at, chunk_index,
           total_chunks, custom)
         VALUES ${rows.join(', ')}
         ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
           document_id = EXCLUDED.document_id, title = EXCLUDED.title, source = EXCLUDED.source,
           mime_type = EXCLUDED.mime_type, tenant_id = EXCLUDED.tenant_id,
           access_roles = EXCLUDED.access_roles, tags = EXCLUDED.tags,
           language = EXCLUDED.language, author = EXCLUDED.author,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           chunk_index = EXCLUDED.chunk_index, total_chunks = EXCLUDED.total_chunks,
           custom = EXCLUDED.custom`,
        values,
      );
    }
  }

  /** @inheritdoc */
  override async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const pool = await this.#getPool();
    await pool.query(`DELETE FROM ${this.#table(collection)} WHERE id = ANY($1::text[])`, [ids]);
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
    const pool = await this.#getPool();
    const where = buildWhere(filter, []);
    const res = await pool.query(
      `DELETE FROM ${this.#table(collection)} WHERE ${where.sql}`,
      where.values,
    );
    return { removed: res.rowCount ?? -1 };
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
    const columns: Record<keyof typeof fields, string> = {
      accessRoles: 'access_roles',
      tags: 'tags',
      language: 'language',
      author: 'author',
      title: 'title',
      source: 'source',
      updatedAt: 'updated_at',
    };
    const values: unknown[] = [];
    const sets = (Object.keys(fields) as (keyof typeof fields)[]).map((key) => {
      values.push(fields[key]);
      const cast = key === 'accessRoles' || key === 'tags' ? '::text[]' : '';
      return `${columns[key]} = $${values.length}${cast}`;
    });
    if (sets.length === 0) return { updated: 0 };
    const pool = await this.#getPool();
    const where = buildWhere(filter, values);
    const res = await pool.query(
      `UPDATE ${this.#table(collection)} SET ${sets.join(', ')} WHERE ${where.sql}`,
      where.values,
    );
    return { updated: res.rowCount ?? 0 };
  }

  /** @inheritdoc */
  override async listDocumentIds(collection: string): Promise<string[]> {
    const pool = await this.#getPool();
    const res = await pool.query(
      `SELECT DISTINCT document_id FROM ${this.#table(collection)} WHERE document_id <> ''`,
    );
    return res.rows.map((r) => String(r['document_id']));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query-Time API
  // ─────────────────────────────────────────────────────────────────────────

  /** Nearest-neighbour search with the collection's distance operator. */
  override async search(
    collection: string,
    vector: number[],
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const pool = await this.#getPool();
    const metric = await this.#metric(pool, collection);
    const where = buildWhere(filter, [toVectorLiteral(vector), topK]);
    const res = await pool.query(
      `SELECT ${COLUMNS}, embedding ${OPERATOR[metric]} $1::vector AS distance
         FROM ${this.#table(collection)} WHERE ${where.sql}
         ORDER BY embedding ${OPERATOR[metric]} $1::vector LIMIT $2`,
      where.values,
    );
    return res.rows.map((row) =>
      toPassage(fromRow(row), collection, vectorScore(metric, similarity(metric, row['distance']))),
    );
  }

  /**
   * Full-text search with `ts_rank_cd`. Any query term may match (OR
   * semantics), in line with the other adapters.
   */
  override async keywordSearch(
    collection: string,
    query: string,
    topK: number,
    filter?: RAGFilter,
  ): Promise<Passage[]> {
    const pool = await this.#getPool();
    const tsConfig = await this.#collectionTsConfig(pool, collection);
    const where = buildWhere(filter, [query, topK, tsConfig]);
    // plainto_tsquery joins terms with AND; turning `&` into `|` keeps the
    // stemming and stop-word handling while matching any term.
    const res = await pool.query(
      `WITH q AS (
         SELECT replace(plainto_tsquery($3::regconfig, $1)::text, '&', '|')::tsquery AS query
       )
       SELECT ${COLUMNS}, ts_rank_cd(tsv, q.query, 32) AS rank
         FROM ${this.#table(collection)}, q
        WHERE tsv @@ q.query AND ${where.sql}
        ORDER BY rank DESC LIMIT $2`,
      where.values,
    );
    return res.rows.map((row) => toPassage(fromRow(row), collection, Number(row['rank'] ?? 0)));
  }

  /** Hybrid search: vector and keyword rankings fused with Reciprocal Rank Fusion. */
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

  async #getPool(): Promise<PgVectorPool> {
    if (this.#pool !== undefined) return this.#pool;
    this.#poolPromise ??= (async (): Promise<PgVectorPool> => {
      const pg = await importPg();
      const c = this.#config;
      const pool = new pg.Pool({
        ...(c.connectionString !== undefined && { connectionString: c.connectionString }),
        ...(c.host !== undefined && { host: c.host }),
        ...(c.port !== undefined && { port: c.port }),
        ...(c.database !== undefined && { database: c.database }),
        ...(c.user !== undefined && { user: c.user }),
        ...(c.password !== undefined && { password: c.password }),
        ...(c.ssl !== undefined && { ssl: c.ssl }),
        max: c.maxConnections ?? 10,
      });
      this.#pool = pool;
      return pool;
    })();
    return this.#poolPromise;
  }

  #table(collection: string): string {
    const name = `${this.#prefix}${collection}`;
    if (collection === '' || Buffer.byteLength(name) > 63) {
      throw new RAGError(
        `pgvector: collection name '${collection}' must be non-empty and, with the prefix, at most 63 bytes`,
        'collection',
      );
    }
    if (name === `${this.#prefix}collections`) {
      throw new RAGError(`pgvector: '${collection}' is a reserved collection name`, 'collection');
    }
    return `${quoteIdent(this.#schema)}.${quoteIdent(name)}`;
  }

  /** Short, collision-free base name for a collection's indexes (identifiers max 63 bytes). */
  #indexBase(collection: string): string {
    return `${this.#prefix}${hashName(collection)}`;
  }

  #metaTable(): string {
    return `${quoteIdent(this.#schema)}.${quoteIdent(`${this.#prefix}collections`)}`;
  }

  async #ensureMetaTable(pool: PgVectorPool): Promise<void> {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#metaTable()} (
        name text PRIMARY KEY,
        embedding_provider text NOT NULL DEFAULT '',
        embedding_model text NOT NULL DEFAULT '',
        dimensions integer NOT NULL,
        distance_metric text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
  }

  async #metaTableExists(pool: PgVectorPool): Promise<boolean> {
    const res = await pool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [
      this.#metaTable(),
    ]);
    return res.rows[0]?.['exists'] === true;
  }

  async #metric(
    pool: PgVectorPool,
    collection: string,
  ): Promise<CollectionConfig['distanceMetric']> {
    const cached = this.#metrics.get(collection);
    if (cached !== undefined) return cached;
    let metric: CollectionConfig['distanceMetric'] = 'cosine';
    if (await this.#metaTableExists(pool)) {
      const res = await pool.query(
        `SELECT distance_metric FROM ${this.#metaTable()} WHERE name = $1`,
        [collection],
      );
      const found = res.rows[0]?.['distance_metric'];
      if (found === 'dot' || found === 'euclidean' || found === 'cosine') metric = found;
    }
    this.#metrics.set(collection, metric);
    return metric;
  }

  /** Text-search configuration baked into the collection's generated column. */
  async #collectionTsConfig(pool: PgVectorPool, collection: string): Promise<string> {
    const res = await pool.query(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
         FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = to_regclass($1) AND a.attname = 'tsv'`,
      [this.#table(collection)],
    );
    const expr = str(res.rows[0]?.['expr']);
    const match = /to_tsvector\('([A-Za-z0-9_]+)'/.exec(expr);
    return match?.[1] ?? this.#config.textSearchConfig ?? 'simple';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Double-quotes a PostgreSQL identifier. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Stable 12-hex-digit hash of a collection name, for index names. */
function hashName(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < name.length; i++) {
    h1 = Math.imul(h1 ^ name.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ name.charCodeAt(i), 0x811c9dc5);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).slice(0, 4)).slice(
    0,
    12,
  );
}

/** pgvector text literal: `[0.1,0.2,…]`. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** Converts pgvector's operator output into a similarity or distance for {@link vectorScore}. */
function similarity(metric: CollectionConfig['distanceMetric'], raw: unknown): number {
  const value = Number(raw);
  switch (metric) {
    case 'cosine':
      return 1 - value; // `<=>` is cosine distance
    case 'dot':
      return -value; // `<#>` is the negative inner product
    case 'euclidean':
    default:
      return value; // `<->` is the L2 distance
  }
}

function fromRow(row: Record<string, unknown>): Partial<ChunkRecord> {
  return {
    id: String(row['id']),
    content: str(row['content']),
    documentId: str(row['document_id']),
    title: str(row['title']),
    source: str(row['source']),
    mimeType: str(row['mime_type']),
    tenantId: str(row['tenant_id']),
    accessRoles: (row['access_roles'] as string[] | null) ?? [],
    tags: (row['tags'] as string[] | null) ?? [],
    language: str(row['language']),
    author: str(row['author']),
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
    chunkIndex: Number(row['chunk_index'] ?? 0),
    totalChunks: Number(row['total_chunks'] ?? 0),
    custom: (row['custom'] as Record<string, unknown> | null) ?? {},
  };
}

/**
 * Builds a parameterised `WHERE` clause from a {@link RAGFilter}. Values are
 * appended to `values`, which already holds the query's own parameters.
 */
function buildWhere(
  filter: RAGFilter | undefined,
  values: unknown[],
): { sql: string; values: unknown[] } {
  const params = [...values];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses: string[] = [];
  if (filter !== undefined) {
    requireScalarMetadataFilter(filter, 'pgvector');
    if (filter.tenantId !== undefined && filter.tenantId !== '') {
      clauses.push(`tenant_id = ${add(filter.tenantId)}`);
    }
    if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
      clauses.push(
        `(cardinality(access_roles) = 0 OR access_roles && ${add(visibleRoles(filter))}::text[])`,
      );
    }
    if (filter.tags !== undefined && filter.tags.length > 0) {
      clauses.push(`tags && ${add(filter.tags)}::text[]`);
    }
    if (filter.tagsAll !== undefined && filter.tagsAll.length > 0) {
      clauses.push(`tags @> ${add(filter.tagsAll)}::text[]`);
    }
    if (filter.documentId !== undefined) {
      clauses.push(`document_id = ANY(${add(documentIdList(filter))}::text[])`);
    }
    if (filter.language !== undefined && filter.language !== '') {
      clauses.push(`language = ${add(filter.language)}`);
    }
    if (filter.dateRange?.from !== undefined) {
      clauses.push(`created_at >= ${add(filter.dateRange.from.getTime())}`);
    }
    if (filter.dateRange?.to !== undefined) {
      clauses.push(`created_at <= ${add(filter.dateRange.to.getTime())}`);
    }
    if (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0) {
      clauses.push(`custom @> ${add(JSON.stringify(filter.metadata))}::jsonb`);
    }
  }
  return { sql: clauses.length > 0 ? clauses.join(' AND ') : 'TRUE', values: params };
}

/** The slice of the `pg` module namespace this adapter needs. */
interface PgModule {
  Pool: new (options: Record<string, unknown>) => PgVectorPool;
}

/**
 * Imports `pg` dynamically, turning a missing install into a clear message.
 *
 * @throws {@link RAGError} when the package is absent.
 */
async function importPg(): Promise<PgModule> {
  try {
    // Held in a variable so the compiler does not resolve `pg` at build time:
    // the SDK does not declare it, and consumers that never use pgvector
    // should not need it to typecheck or build.
    const specifier = 'pg';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: PgModule;
      Pool?: PgModule['Pool'];
    };
    const resolved = mod.Pool !== undefined ? (mod as PgModule) : mod.default;
    if (resolved?.Pool === undefined) throw new Error("the 'pg' module exposes no Pool export");
    return resolved;
  } catch (err) {
    throw new RAGError(
      "pgvector: the 'pg' package is required by PgVectorAdapter but could not be loaded. " +
        'Install it in the host application (`npm install pg`), or pass an open pool as `pool`.',
      'vectorStore',
      { cause: err },
    );
  }
}
