import { describe, it, expect } from 'vitest';
import { QdrantAdapter } from '../../../../src/rag/vectorstore/QdrantAdapter.js';
import { chunkUuid } from '../../../../src/rag/vectorstore/common.js';
import { mockFetch } from '../../../fixtures/mockFetch.js';
import type { Route } from '../../../fixtures/mockFetch.js';

const exists = (value: boolean): Route => ({
  method: 'GET',
  path: /\/exists$/,
  reply: () => ({ result: { exists: value } }),
});
const meta: Route = {
  method: 'POST',
  path: /^\/collections\/agent349_collections\/points$/,
  reply: () => ({ result: [{ payload: { distanceMetric: 'cosine', dimensions: 3 } }] }),
};

describe('QdrantAdapter', () => {
  it('creates dense and sparse (IDF) vectors, payload indexes and metadata', async () => {
    let collectionExists = false;
    const { fetch, calls } = mockFetch([
      { method: 'GET', path: /\/exists$/, reply: () => ({ result: { exists: collectionExists } }) },
      {
        method: 'PUT',
        path: /^\/collections\/docs$/,
        reply: () => {
          collectionExists = true;
          return { result: true };
        },
      },
      { method: 'PUT', path: /./, reply: () => ({ result: true }) },
    ]);
    await new QdrantAdapter({ fetch, apiKey: 'secret' }).createCollection('docs', {
      dimensions: 3,
      distanceMetric: 'euclidean',
      embeddingProvider: 'openai',
      embeddingModel: 'openai/m',
    });
    const create = calls.find((c) => c.method === 'PUT' && c.path === '/collections/docs')!;
    expect(create.body).toEqual({
      vectors: { dense: { size: 3, distance: 'Euclid' } },
      sparse_vectors: { text: { modifier: 'idf' } },
    });
    expect(create.headers['api-key']).toBe('secret');
    const indexed = calls
      .filter((c) => c.path.startsWith('/collections/docs/index'))
      .map((c) => (c.body as { field_name: string }).field_name);
    expect(indexed).toEqual([
      'tenantId',
      'documentId',
      'accessRoles',
      'tags',
      'language',
      'createdAt',
    ]);
  });

  it('stores chunks under deterministic UUIDs with the original ID in the payload', async () => {
    const { fetch, calls } = mockFetch([
      { method: 'PUT', path: /points/, reply: () => ({ result: {} }) },
    ]);
    await new QdrantAdapter({ fetch }).upsert('docs', [
      { id: 'd_chunk_0', content: 'hello world', vector: [1, 0, 0], metadata: { documentId: 'd' } },
    ]);
    const point = (calls[0]!.body as { points: Record<string, unknown>[] }).points[0]!;
    expect(point['id']).toBe(chunkUuid('d_chunk_0'));
    expect(point['payload']).toMatchObject({ id: 'd_chunk_0', documentId: 'd' });
    const vector = point['vector'] as { dense: number[]; text: { indices: number[] } };
    expect(vector.dense).toEqual([1, 0, 0]);
    expect(vector.text.indices).toHaveLength(2);
  });

  it('translates filters, including public and wildcard roles', async () => {
    const { fetch, calls } = mockFetch([
      exists(true),
      meta,
      { method: 'POST', path: /points\/query$/, reply: () => ({ result: { points: [] } }) },
    ]);
    await new QdrantAdapter({ fetch }).search('docs', [1, 0, 0], 3, {
      tenantId: 'acme',
      accessRoles: ['hr'],
      tagsAll: ['a', 'b'],
      dateRange: { from: new Date(10) },
      metadata: { dept: 'hr' },
    });
    const query = calls.find((c) => c.path.endsWith('/points/query'))!.body as Record<
      string,
      unknown
    >;
    expect(query['using']).toBe('dense');
    expect(query['filter']).toEqual({
      must: [
        { key: 'tenantId', match: { value: 'acme' } },
        {
          should: [
            { is_empty: { key: 'accessRoles' } },
            { key: 'accessRoles', match: { any: ['hr', '*'] } },
          ],
        },
        { key: 'tags', match: { value: 'a' } },
        { key: 'tags', match: { value: 'b' } },
        { key: 'createdAt', range: { gte: 10 } },
        { key: 'custom.dept', match: { value: 'hr' } },
      ],
    });
  });

  it('scores keyword results relative to the best match', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'POST',
        path: /points\/query$/,
        reply: () => ({
          result: {
            points: [
              { id: 'u1', score: 4, payload: { id: 'a', content: 'x' } },
              { id: 'u2', score: 1, payload: { id: 'b', content: 'y' } },
            ],
          },
        }),
      },
    ]);
    const results = await new QdrantAdapter({ fetch }).keywordSearch('docs', 'salary', 5);
    expect(results.map((p) => [p.id, p.score])).toEqual([
      ['a', 1],
      ['b', 0.25],
    ]);
    expect((calls[0]!.body as { using: string }).using).toBe('text');
    expect(await new QdrantAdapter({ fetch }).keywordSearch('docs', '  ', 5)).toEqual([]);
  });

  it('pages through scroll results when listing document IDs', async () => {
    let page = 0;
    const { fetch } = mockFetch([
      {
        method: 'POST',
        path: /points\/scroll$/,
        reply: () => {
          page++;
          return page === 1
            ? {
                result: {
                  points: [{ id: '1', payload: { documentId: 'a' } }],
                  next_page_offset: 'next',
                },
              }
            : {
                result: {
                  points: [{ id: '2', payload: { documentId: 'b' } }],
                  next_page_offset: null,
                },
              };
        },
      },
    ]);
    expect((await new QdrantAdapter({ fetch }).listDocumentIds('docs')).sort()).toEqual(['a', 'b']);
  });

  it('rejects the reserved metadata collection name and empty bulk filters', async () => {
    const { fetch } = mockFetch([]);
    const store = new QdrantAdapter({ fetch });
    await expect(store.collectionExists('agent349_collections')).rejects.toThrow(/not a valid/);
    await expect(store.removeDocumentsByFilter('docs', {})).rejects.toThrow(/empty filter/);
  });
});
