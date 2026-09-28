import { describe, it, expect } from 'vitest';
import { PineconeAdapter } from '../../../../src/rag/vectorstore/PineconeAdapter.js';
import { RAGError } from '../../../../src/errors/RAGError.js';
import { mockFetch } from '../../../fixtures/mockFetch.js';
import type { Route } from '../../../fixtures/mockFetch.js';

const index: Route = {
  method: 'GET',
  path: /^\/indexes\/kb$/,
  reply: () => ({
    host: 'kb-host.pinecone.io',
    dimension: 3,
    metric: 'cosine',
    status: { ready: true },
  }),
};

function adapter(routes: Route[]) {
  const mock = mockFetch([index, ...routes]);
  return {
    store: new PineconeAdapter({ indexName: 'kb', apiKey: 'pk', fetch: mock.fetch }),
    calls: mock.calls,
  };
}

describe('PineconeAdapter', () => {
  it('requires an index name', () => {
    expect(() => new PineconeAdapter({ indexName: '' })).toThrow(RAGError);
  });

  it('refuses keyword and hybrid search with guidance', async () => {
    const { store } = adapter([]);
    await expect(store.keywordSearch()).rejects.toThrow(/searchMode to "vector"/);
    await expect(store.hybridSearch()).rejects.toThrow(/not supported/);
  });

  it('rejects a collection whose dimensions or metric differ from the index', async () => {
    const { store } = adapter([]);
    await expect(
      store.createCollection('docs', {
        dimensions: 1536,
        distanceMetric: 'cosine',
        embeddingProvider: 'openai',
        embeddingModel: 'openai/m',
      }),
    ).rejects.toThrow(/One index serves every collection/);
  });

  it('writes to the collection namespace on the discovered data plane', async () => {
    const { store, calls } = adapter([
      { method: 'POST', path: /^\/vectors\/upsert$/, reply: () => ({ upsertedCount: 1 }) },
    ]);
    await store.upsert('docs', [
      {
        id: 'd_chunk_0',
        content: 'x',
        vector: [1, 0, 0],
        metadata: { documentId: 'd', accessRoles: [] },
      },
    ]);
    const upsert = calls.find((c) => c.path === '/vectors/upsert')!;
    expect(upsert.url).toBe('https://kb-host.pinecone.io/vectors/upsert');
    expect(upsert.headers['Api-Key']).toBe('pk');
    const body = upsert.body as {
      namespace: string;
      vectors: { metadata: Record<string, unknown> }[];
    };
    expect(body.namespace).toBe('docs');
    // Public chunks carry a marker, since Pinecone cannot filter on empty lists.
    expect(body.vectors[0]!.metadata['accessRoles']).toEqual(['__public__']);
  });

  it('translates filters and hides the public marker on read', async () => {
    const { store, calls } = adapter([
      {
        method: 'POST',
        path: /^\/query$/,
        reply: () => ({
          matches: [
            {
              id: 'a',
              score: 1,
              metadata: { content: 'x', documentId: 'd', accessRoles: ['__public__'] },
            },
          ],
        }),
      },
    ]);
    const [top] = await store.search('docs', [1, 0, 0], 3, {
      tenantId: 'acme',
      accessRoles: ['hr'],
      tagsAll: ['a', 'b'],
    });
    expect((calls.find((c) => c.path === '/query')!.body as { filter: unknown }).filter).toEqual({
      $and: [
        { tenantId: { $eq: 'acme' } },
        { accessRoles: { $in: ['hr', '*', '__public__'] } },
        { tags: { $in: ['a'] } },
        { tags: { $in: ['b'] } },
      ],
    });
    expect(top).toMatchObject({ id: 'a', score: 1 });
    expect(top!.metadata).not.toHaveProperty('accessRoles');
  });

  it('removes by filter by listing the namespace and deleting matching IDs', async () => {
    const { store, calls } = adapter([
      {
        method: 'GET',
        path: /^\/vectors\/list/,
        reply: () => ({ vectors: [{ id: 'a' }, { id: 'b' }] }),
      },
      {
        method: 'GET',
        path: /^\/vectors\/fetch/,
        reply: () => ({
          vectors: {
            a: { id: 'a', metadata: { documentId: 'doc-1' } },
            b: { id: 'b', metadata: { documentId: 'doc-2' } },
          },
        }),
      },
      { method: 'POST', path: /^\/vectors\/delete$/, reply: () => ({}) },
    ]);
    const res = await store.removeDocumentsByFilter('docs', { documentId: 'doc-1' });
    expect(res.removed).toBe(1);
    expect(calls.find((c) => c.path === '/vectors/delete')!.body).toEqual({
      namespace: 'docs',
      ids: ['a'],
    });
    await expect(store.removeDocumentsByFilter('docs', {})).rejects.toThrow(/empty filter/);
  });

  it('rejects custom metadata filters instead of ignoring them', async () => {
    const { store } = adapter([]);
    await expect(store.search('docs', [1, 0, 0], 1, { metadata: { k: 'v' } })).rejects.toThrow(
      /filter.metadata is not supported/,
    );
  });
});
