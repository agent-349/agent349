import { describe, it, expect } from 'vitest';
import {
  bm25DocumentVector,
  bm25QueryVector,
  chunkUuid,
  hasActiveFilter,
  matchesFilter,
  requestJson,
  requireActiveFilter,
  requireScalarMetadataFilter,
  scaleByMax,
  toChunkPatch,
  toChunkRecord,
  toPassage,
  vectorScore,
} from '../../../../src/rag/vectorstore/common.js';
import { RAGError } from '../../../../src/errors/RAGError.js';
import { mockFetch } from '../../../fixtures/mockFetch.js';
import type { VectorDocument } from '../../../../src/types/index.js';

const doc: VectorDocument = {
  id: 'd_chunk_0',
  content: 'hello world',
  vector: [1, 0],
  metadata: {
    documentId: 'd',
    tenantId: 'acme',
    accessRoles: ['hr'],
    tags: ['a', 'b'],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    custom: { dept: 'hr' },
  },
};

describe('record mapping', () => {
  it('round-trips a document through its stored record', () => {
    const record = toChunkRecord(doc);
    expect(record).toMatchObject({
      id: 'd_chunk_0',
      title: '',
      createdAt: Date.parse('2024-01-01T00:00:00Z'),
    });
    const passage = toPassage(record, 'col', 0.5);
    expect(passage).toMatchObject({
      id: 'd_chunk_0',
      content: 'hello world',
      score: 0.5,
      collection: 'col',
    });
    expect(passage.metadata).toMatchObject({
      documentId: 'd',
      tenantId: 'acme',
      tags: ['a', 'b'],
      custom: { dept: 'hr' },
    });
    expect(passage.metadata.createdAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(passage.metadata).not.toHaveProperty('title');
  });
});

describe('filters', () => {
  const record = toChunkRecord(doc);

  it('detects empty filters', () => {
    expect(hasActiveFilter(undefined)).toBe(false);
    expect(hasActiveFilter({})).toBe(false);
    expect(hasActiveFilter({ tags: [], documentId: [] })).toBe(false);
    expect(hasActiveFilter({ documentId: 'd' })).toBe(true);
    expect(() => requireActiveFilter({}, 'delete')).toThrow(RAGError);
  });

  it('applies the reference semantics', () => {
    expect(matchesFilter(record, { tenantId: 'acme' })).toBe(true);
    expect(matchesFilter(record, { tenantId: 'globex' })).toBe(false);
    expect(matchesFilter(record, { accessRoles: ['hr'] })).toBe(true);
    expect(matchesFilter(record, { accessRoles: ['it'] })).toBe(false);
    expect(matchesFilter({ ...record, accessRoles: [] }, { accessRoles: ['it'] })).toBe(true);
    expect(matchesFilter({ ...record, accessRoles: ['*'] }, { accessRoles: ['it'] })).toBe(true);
    expect(matchesFilter(record, { tags: ['z', 'a'] })).toBe(true);
    expect(matchesFilter(record, { tagsAll: ['a', 'z'] })).toBe(false);
    expect(matchesFilter(record, { dateRange: { from: new Date('2025-01-01') } })).toBe(false);
    expect(matchesFilter(record, { metadata: { dept: 'hr' } })).toBe(true);
    expect(matchesFilter(record, { metadata: { dept: 'it' } })).toBe(false);
  });

  it('only accepts scalar metadata values', () => {
    expect(() =>
      requireScalarMetadataFilter({ metadata: { a: 1, b: 'x', c: true } }, 'x'),
    ).not.toThrow();
    expect(() => requireScalarMetadataFilter({ metadata: { a: { nested: 1 } } }, 'x')).toThrow(
      /must be a string, number or boolean/,
    );
  });

  it('builds patches from the patchable fields only', () => {
    expect(toChunkPatch({})).toEqual({});
    const patch = toChunkPatch({ tags: ['x'], documentId: 'ignored' });
    expect(patch.tags).toEqual(['x']);
    expect(patch).not.toHaveProperty('documentId');
    expect(typeof patch.updatedAt).toBe('number');
  });
});

describe('scores', () => {
  it('maps raw engine scores into [0, 1]', () => {
    expect(vectorScore('cosine', 1)).toBe(1);
    expect(vectorScore('cosine', -1)).toBe(0);
    expect(vectorScore('cosine', 0)).toBe(0.5);
    expect(vectorScore('euclidean', 0)).toBe(1);
    expect(vectorScore('euclidean', 1)).toBe(0.5);
    expect(vectorScore('dot', 0)).toBe(0.5);
  });

  it('scales unbounded scores by the best one', () => {
    expect(scaleByMax([{ score: 4 }, { score: 2 }]).map((p) => p.score)).toEqual([1, 0.5]);
    expect(scaleByMax([{ score: 0 }])).toEqual([{ score: 0 }]);
  });
});

describe('identifiers and sparse vectors', () => {
  it('derives stable, valid UUIDs', () => {
    const a = chunkUuid('doc_chunk_0');
    expect(a).toBe(chunkUuid('doc_chunk_0'));
    expect(a).not.toBe(chunkUuid('doc_chunk_1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes BM25 term frequencies that share dimensions with the query', () => {
    const d = bm25DocumentVector('Salary salary bands');
    const q = bm25QueryVector('salary');
    expect(d.indices).toHaveLength(2);
    expect(d.indices).toContain(q.indices[0]);
    const salary = d.values[d.indices.indexOf(q.indices[0]!)]!;
    const bands = d.values.find((_, i) => i !== d.indices.indexOf(q.indices[0]!))!;
    expect(salary).toBeGreaterThan(bands);
    expect(bm25QueryVector('   ').indices).toEqual([]);
  });
});

describe('requestJson', () => {
  const http = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) => ({
    baseUrl: 'http://engine',
    headers: { 'api-key': 'k' },
    timeoutMs: 1000,
    fetch: fetchImpl,
    adapter: 'test',
  });

  it('sends JSON and parses the reply', async () => {
    const { fetch, calls } = mockFetch([
      { method: 'POST', path: /^\/x$/, reply: () => ({ ok: 1 }) },
    ]);
    await expect(requestJson(http(fetch), 'POST', '/x', { a: 1 })).resolves.toEqual({ ok: 1 });
    expect(calls[0]!.body).toEqual({ a: 1 });
    expect(calls[0]!.headers['api-key']).toBe('k');
  });

  it('turns HTTP errors and network failures into RAGError', async () => {
    const { fetch } = mockFetch([
      { method: 'GET', path: /^\/bad$/, reply: () => ({ status: 500, body: { message: 'boom' } }) },
    ]);
    await expect(requestJson(http(fetch), 'GET', '/bad')).rejects.toThrow(/HTTP 500.*boom/);
    const failing = async (): Promise<Response> => {
      throw new Error('ECONNREFUSED');
    };
    await expect(requestJson(http(failing), 'GET', '/x')).rejects.toThrow(/ECONNREFUSED/);
  });
});
