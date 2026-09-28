import { createHash } from 'node:crypto';
import type {
  CollectionConfig,
  DocumentMetadata,
  Passage,
  RAGFilter,
  VectorDocument,
} from '../types.js';
import { RAGError } from '../../errors/RAGError.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared building blocks for the database-backed vector store adapters
// (pgvector, Qdrant, Pinecone, Weaviate, Milvus). Keeping the record shape,
// filter rules and score mapping in one place is what makes the adapters
// interchangeable.
// ─────────────────────────────────────────────────────────────────────────────

/** Role that makes a chunk visible to every caller of its tenant. */
export const WILDCARD_ROLE = '*';

/**
 * Flat representation of a chunk, as stored by every database-backed adapter.
 *
 * Dates are epoch milliseconds (`0` = unknown) and optional strings are `''`,
 * so the record fits engines without a notion of "absent field".
 */
export interface ChunkRecord {
  id: string;
  content: string;
  documentId: string;
  title: string;
  source: string;
  mimeType: string;
  tenantId: string;
  accessRoles: string[];
  tags: string[];
  language: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  chunkIndex: number;
  totalChunks: number;
  custom: Record<string, unknown>;
}

/** Converts a {@link VectorDocument} to its stored {@link ChunkRecord} (without the vector). */
export function toChunkRecord(doc: VectorDocument): ChunkRecord {
  const meta = doc.metadata;
  return {
    id: doc.id,
    content: doc.content,
    documentId: meta.documentId,
    title: meta.title ?? '',
    source: meta.source ?? '',
    mimeType: meta.mimeType ?? '',
    tenantId: meta.tenantId ?? '',
    accessRoles: meta.accessRoles ?? [],
    tags: meta.tags ?? [],
    language: meta.language ?? '',
    author: meta.author ?? '',
    createdAt: meta.createdAt instanceof Date ? meta.createdAt.getTime() : 0,
    updatedAt: meta.updatedAt instanceof Date ? meta.updatedAt.getTime() : 0,
    chunkIndex: meta.chunkIndex ?? 0,
    totalChunks: meta.totalChunks ?? 0,
    custom: meta.custom ?? {},
  };
}

/**
 * Rebuilds a {@link Passage} from a stored record. Empty strings, empty lists
 * and zero dates are treated as absent, mirroring how they were written.
 */
export function toPassage(
  record: Partial<ChunkRecord>,
  collection: string,
  score: number,
): Passage {
  const nonEmpty = (v: string | undefined): v is string => typeof v === 'string' && v !== '';
  const metadata: DocumentMetadata = { documentId: record.documentId ?? '' };
  if (nonEmpty(record.title)) metadata.title = record.title;
  if (nonEmpty(record.source)) metadata.source = record.source;
  if (nonEmpty(record.mimeType)) metadata.mimeType = record.mimeType;
  if (nonEmpty(record.tenantId)) metadata.tenantId = record.tenantId;
  if (nonEmpty(record.language)) metadata.language = record.language;
  if (nonEmpty(record.author)) metadata.author = record.author;
  if (record.accessRoles !== undefined && record.accessRoles.length > 0) {
    metadata.accessRoles = record.accessRoles;
  }
  if (record.tags !== undefined && record.tags.length > 0) metadata.tags = record.tags;
  if (typeof record.chunkIndex === 'number') metadata.chunkIndex = record.chunkIndex;
  if (typeof record.totalChunks === 'number' && record.totalChunks > 0) {
    metadata.totalChunks = record.totalChunks;
  }
  if (typeof record.createdAt === 'number' && record.createdAt > 0) {
    metadata.createdAt = new Date(record.createdAt);
  }
  if (typeof record.updatedAt === 'number' && record.updatedAt > 0) {
    metadata.updatedAt = new Date(record.updatedAt);
  }
  if (record.custom !== undefined && Object.keys(record.custom).length > 0) {
    metadata.custom = record.custom;
  }
  return { id: record.id ?? '', content: record.content ?? '', score, collection, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

/** Returns `true` when the filter has at least one active field. */
export function hasActiveFilter(filter: RAGFilter | undefined): boolean {
  if (filter === undefined) return false;
  const hasDocumentId =
    typeof filter.documentId === 'string' ||
    (Array.isArray(filter.documentId) && filter.documentId.length > 0);
  return (
    (filter.tenantId !== undefined && filter.tenantId !== '') ||
    (filter.tags !== undefined && filter.tags.length > 0) ||
    (filter.tagsAll !== undefined && filter.tagsAll.length > 0) ||
    hasDocumentId ||
    (filter.language !== undefined && filter.language !== '') ||
    filter.dateRange?.from !== undefined ||
    filter.dateRange?.to !== undefined ||
    (filter.accessRoles !== undefined && filter.accessRoles.length > 0) ||
    (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0)
  );
}

/**
 * Rejects a filter with no active fields. Bulk delete/update must never run
 * unscoped: wiping a collection goes through `deleteCollection()`.
 *
 * @throws {@link RAGError} when the filter is empty.
 */
export function requireActiveFilter(filter: RAGFilter, operation: 'delete' | 'update'): void {
  if (!hasActiveFilter(filter)) {
    throw new RAGError(
      `Refusing to ${operation} with an empty filter — use deleteCollection() to wipe a collection`,
      'filter',
    );
  }
}

/** Normalises `filter.documentId` to a list (empty when absent). */
export function documentIdList(filter: RAGFilter): string[] {
  if (filter.documentId === undefined) return [];
  return Array.isArray(filter.documentId) ? filter.documentId : [filter.documentId];
}

/** Roles that grant visibility for a caller: their own plus the wildcard role. */
export function visibleRoles(filter: RAGFilter): string[] {
  return [...(filter.accessRoles ?? []), WILDCARD_ROLE];
}

/**
 * Reference implementation of the filter semantics every adapter reproduces
 * natively: `tags` is OR, `tagsAll` is AND, chunks with no `accessRoles` (or
 * the `'*'` role) are visible to every role, and `metadata` matches
 * `custom` fields exactly. Adapters use it where an engine cannot evaluate a
 * filter server-side.
 */
export function matchesFilter(record: ChunkRecord, filter: RAGFilter): boolean {
  if (
    filter.tenantId !== undefined &&
    filter.tenantId !== '' &&
    record.tenantId !== filter.tenantId
  ) {
    return false;
  }
  if (
    filter.language !== undefined &&
    filter.language !== '' &&
    record.language !== filter.language
  ) {
    return false;
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    if (!filter.tags.some((t) => record.tags.includes(t))) return false;
  }
  if (filter.tagsAll !== undefined && filter.tagsAll.length > 0) {
    if (!filter.tagsAll.every((t) => record.tags.includes(t))) return false;
  }
  const ids = documentIdList(filter);
  if (filter.documentId !== undefined && !ids.includes(record.documentId)) return false;
  if (filter.accessRoles !== undefined && filter.accessRoles.length > 0) {
    const roles = visibleRoles(filter);
    if (record.accessRoles.length > 0 && !record.accessRoles.some((r) => roles.includes(r))) {
      return false;
    }
  }
  if (filter.dateRange?.from !== undefined && record.createdAt < filter.dateRange.from.getTime()) {
    return false;
  }
  if (filter.dateRange?.to !== undefined && record.createdAt > filter.dateRange.to.getTime()) {
    return false;
  }
  if (filter.metadata !== undefined) {
    for (const [key, value] of Object.entries(filter.metadata)) {
      if (record.custom[key] !== value) return false;
    }
  }
  return true;
}

/**
 * Validates that `filter.metadata` only holds values an engine can compare for
 * equality (strings, finite numbers, booleans).
 *
 * @throws {@link RAGError} for any other value type.
 */
export function requireScalarMetadataFilter(filter: RAGFilter | undefined, adapter: string): void {
  for (const [key, value] of Object.entries(filter?.metadata ?? {})) {
    const scalar =
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!scalar) {
      throw new RAGError(
        `${adapter}: filter.metadata.${key} must be a string, number or boolean`,
        'filter.metadata',
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata patches
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata fields `updateDocumentsMetadata()` may change, in stored form. */
export type ChunkPatch = Partial<
  Pick<
    ChunkRecord,
    'accessRoles' | 'tags' | 'language' | 'author' | 'title' | 'source' | 'updatedAt'
  >
>;

/**
 * Keeps the patchable subset of a metadata patch and stamps `updatedAt`.
 * Returns an empty object when nothing patchable was given.
 */
export function toChunkPatch(patch: Partial<DocumentMetadata>): ChunkPatch {
  const out: ChunkPatch = {};
  if (patch.accessRoles !== undefined) out.accessRoles = patch.accessRoles;
  if (patch.tags !== undefined) out.tags = patch.tags;
  if (patch.language !== undefined) out.language = patch.language;
  if (patch.author !== undefined) out.author = patch.author;
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.source !== undefined) out.source = patch.source;
  if (Object.keys(out).length > 0) out.updatedAt = Date.now();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps an engine's raw vector score to the adapter contract's `[0, 1]` range.
 *
 * - `cosine` similarity in `[-1, 1]` → `(s + 1) / 2` (same as the in-memory store);
 * - `dot` product (unbounded) → logistic function;
 * - `euclidean` distance (`≥ 0`, lower is better) → `1 / (1 + d)`.
 */
export function vectorScore(metric: CollectionConfig['distanceMetric'], raw: number): number {
  switch (metric) {
    case 'euclidean':
      return 1 / (1 + Math.max(0, raw));
    case 'dot':
      return 1 / (1 + Math.exp(-raw));
    case 'cosine':
    default:
      return Math.min(1, Math.max(0, (raw + 1) / 2));
  }
}

/** Scales unbounded relevance scores (e.g. BM25) to `[0, 1]` by the best score in the set. */
export function scaleByMax<T extends { score: number }>(items: T[]): T[] {
  const max = items.reduce((m, p) => Math.max(m, p.score), 0);
  if (max <= 0) return items;
  return items.map((p) => ({ ...p, score: p.score / max }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic UUID (version 5 layout, SHA-1 based) for a chunk ID. Engines
 * that only accept UUID keys (Qdrant, Weaviate) store the chunk under this key
 * and keep the original ID in the payload, so upserts stay idempotent.
 */
export function chunkUuid(id: string): string {
  const bytes = createHash('sha1').update(`agent349:${id}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword search with sparse vectors
// ─────────────────────────────────────────────────────────────────────────────

/** Sparse vector in the `{ indices, values }` form used by Qdrant. */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/** Lower-cased word tokens (letters and digits in any script). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** 32-bit FNV-1a hash, used to map tokens to sparse dimensions. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * BM25 term-frequency part of a document, as a sparse vector. The engine
 * supplies the inverse document frequency (Qdrant's `idf` modifier), so the
 * product of query and document vectors is a BM25 score.
 *
 * @param k1     - Term-frequency saturation. Default 1.2.
 * @param b      - Length normalisation. Default 0.75.
 * @param avgLen - Assumed average document length in tokens. Default 256.
 */
export function bm25DocumentVector(text: string, k1 = 1.2, b = 0.75, avgLen = 256): SparseVector {
  const tokens = tokenize(text);
  const tf = new Map<number, number>();
  for (const t of tokens) {
    const index = fnv1a(t);
    tf.set(index, (tf.get(index) ?? 0) + 1);
  }
  const norm = k1 * (1 - b + b * (tokens.length / avgLen));
  const indices: number[] = [];
  const values: number[] = [];
  for (const [index, freq] of tf) {
    indices.push(index);
    values.push((freq * (k1 + 1)) / (freq + norm));
  }
  return { indices, values };
}

/** Query side of {@link bm25DocumentVector}: each distinct token weighs 1. */
export function bm25QueryVector(text: string): SparseVector {
  const indices = [...new Set(tokenize(text).map(fnv1a))];
  return { indices, values: indices.map(() => 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal `fetch` signature the HTTP-based adapters depend on (injectable in tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options shared by the HTTP-based adapters. */
export interface HttpClientOptions {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  fetch: FetchLike;
  /** Adapter name, used in error messages. */
  adapter: string;
}

/**
 * Sends a JSON request and returns the parsed body.
 *
 * @throws {@link RAGError} on network failures, timeouts and non-2xx responses,
 *         with the engine's own error text when it provides one.
 */
export async function requestJson<T>(
  http: HttpClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await http.fetch(`${http.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...http.headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(http.timeoutMs),
    });
  } catch (err) {
    throw new RAGError(
      `${http.adapter}: ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      'vectorStore',
      { cause: err },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new RAGError(
      `${http.adapter}: ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
      'vectorStore',
    );
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new RAGError(`${http.adapter}: ${method} ${path} returned invalid JSON`, 'vectorStore', {
      cause: err,
    });
  }
}

/** Reads a stored scalar as text: strings as-is, numbers formatted, anything else `''`. */
export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

/** Global `fetch`, wrapped so adapters can take an injectable {@link FetchLike}. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Removes trailing slashes from a base URL. */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Splits a list into consecutive batches of at most `size` items. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
