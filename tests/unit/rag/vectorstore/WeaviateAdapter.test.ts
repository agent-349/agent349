import { describe, it, expect } from 'vitest';
import { WeaviateAdapter } from '../../../../src/rag/vectorstore/WeaviateAdapter.js';
import { chunkUuid } from '../../../../src/rag/vectorstore/common.js';
import { RAGError } from '../../../../src/errors/RAGError.js';
import { mockFetch } from '../../../fixtures/mockFetch.js';

const metaObject = {
  method: 'GET',
  path: /^\/v1\/objects\/Agent349_Collections\//,
  reply: () => ({ properties: { distanceMetric: 'cosine' } }),
};

describe('WeaviateAdapter', () => {
  it('validates the class prefix and collection names', async () => {
    expect(() => new WeaviateAdapter({ classPrefix: 'lower_' })).toThrow(RAGError);
    const { fetch } = mockFetch([]);
    await expect(new WeaviateAdapter({ fetch }).collectionExists('a b')).rejects.toThrow(
      /letters, digits/,
    );
    await expect(new WeaviateAdapter({ fetch }).collectionExists('Collections')).rejects.toThrow(
      /reserved/,
    );
  });

  it('creates the class with vectors from the SDK and without stop words', async () => {
    const { fetch, calls } = mockFetch([
      { method: 'POST', path: /^\/v1\/schema$/, reply: () => ({}) },
      { method: 'POST', path: /^\/v1\/batch\/objects$/, reply: () => [{ result: {} }] },
    ]);
    await new WeaviateAdapter({ fetch, apiKey: 'k' }).createCollection('hr-docs', {
      dimensions: 3,
      distanceMetric: 'euclidean',
      embeddingProvider: 'openai',
      embeddingModel: 'openai/m',
    });
    const schema = calls.find((c) => c.path === '/v1/schema')!;
    expect(schema.headers['Authorization']).toBe('Bearer k');
    expect(schema.body).toMatchObject({
      class: 'Agent349_hr_docs',
      vectorizer: 'none',
      vectorIndexConfig: { distance: 'l2-squared' },
      invertedIndexConfig: { indexNullState: true, stopwords: { preset: 'none' } },
    });
  });

  it('builds GraphQL filters with unquoted operators and IsNull for public chunks', async () => {
    const { fetch, calls } = mockFetch([
      metaObject,
      {
        method: 'POST',
        path: /^\/v1\/graphql$/,
        reply: () => ({ data: { Get: { Agent349_docs: [] } } }),
      },
    ]);
    await new WeaviateAdapter({ fetch }).search('docs', [1, 0], 4, {
      tenantId: 'acme',
      accessRoles: ['hr'],
      dateRange: { to: new Date(99) },
    });
    const query = (calls.find((c) => c.path === '/v1/graphql')!.body as { query: string }).query;
    expect(query).toContain(
      'Agent349_docs(nearVector: { vector: [1,0] }, limit: 4, where: { operator: And',
    );
    expect(query).toContain('{ path: ["tenantId"], operator: Equal, valueText: "acme" }');
    expect(query).toContain('{ path: ["accessRoles"], operator: IsNull, valueBoolean: true }');
    expect(query).toContain('operator: ContainsAny, valueText: ["hr", "*"]');
    expect(query).toContain('operator: LessThanEqual, valueNumber: 99');
  });

  it('uses valueTextArray for list operands in REST batch deletes', async () => {
    let calls = 0;
    const { fetch, calls: recorded } = mockFetch([
      {
        method: 'DELETE',
        path: /^\/v1\/batch\/objects$/,
        reply: () => ({ results: { matches: calls++ === 0 ? 3 : 0, failed: 0 } }),
      },
    ]);
    const res = await new WeaviateAdapter({ fetch }).removeDocumentsByFilter('docs', {
      documentId: ['a', 'b'],
    });
    expect(res.removed).toBe(3);
    expect((recorded[0]!.body as { match: unknown }).match).toEqual({
      class: 'Agent349_docs',
      where: { path: ['documentId'], operator: 'ContainsAny', valueTextArray: ['a', 'b'] },
    });
  });

  it('rejects custom metadata filters instead of ignoring them', async () => {
    const { fetch } = mockFetch([metaObject]);
    await expect(
      new WeaviateAdapter({ fetch }).search('docs', [1], 1, { metadata: { dept: 'hr' } }),
    ).rejects.toThrow(/filter.metadata is not supported/);
  });

  it('surfaces GraphQL errors and batch write errors', async () => {
    const { fetch } = mockFetch([
      {
        method: 'POST',
        path: /^\/v1\/graphql$/,
        reply: () => ({ errors: [{ message: 'bad query' }] }),
      },
      {
        method: 'POST',
        path: /^\/v1\/batch\/objects$/,
        reply: () => [{ result: { errors: { error: [{ message: 'vector length mismatch' }] } } }],
      },
    ]);
    const store = new WeaviateAdapter({ fetch });
    await expect(store.keywordSearch('docs', 'x', 1)).rejects.toThrow(/bad query/);
    await expect(
      store.upsert('docs', [{ id: 'a', content: 'x', vector: [1], metadata: { documentId: 'd' } }]),
    ).rejects.toThrow(/vector length mismatch/);
  });

  it('maps cosine distance to a [0, 1] score and restores the chunk ID', async () => {
    const { fetch } = mockFetch([
      metaObject,
      {
        method: 'POST',
        path: /^\/v1\/graphql$/,
        reply: () => ({
          data: {
            Get: {
              Agent349_docs: [
                {
                  chunkId: 'd_chunk_0',
                  content: 'x',
                  custom: '{"k":1}',
                  _additional: { id: chunkUuid('d_chunk_0'), distance: 0 },
                },
              ],
            },
          },
        }),
      },
    ]);
    const [top] = await new WeaviateAdapter({ fetch }).search('docs', [1], 1);
    expect(top).toMatchObject({ id: 'd_chunk_0', score: 1, metadata: { custom: { k: 1 } } });
  });
});
