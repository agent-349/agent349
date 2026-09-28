import { describe, it, expect } from 'vitest';
import { MilvusAdapter } from '../../../../src/rag/vectorstore/MilvusAdapter.js';
import { mockFetch } from '../../../fixtures/mockFetch.js';
import type { Route } from '../../../fixtures/mockFetch.js';

const ok = (data: unknown): { code: number; data: unknown } => ({ code: 0, data });
const has = (value: boolean): Route => ({
  method: 'POST',
  path: /\/collections\/has$/,
  reply: () => ok({ has: value }),
});
const meta: Route = {
  method: 'POST',
  path: /\/entities\/query$/,
  reply: (req) =>
    (req.body as { collectionName: string }).collectionName === 'agent349_collections'
      ? ok([{ info: '{"distanceMetric":"cosine","dimensions":3}' }])
      : ok([]),
};

describe('MilvusAdapter', () => {
  it('creates a collection with a BM25 function, both indexes and strong consistency', async () => {
    const { fetch, calls } = mockFetch([
      has(false),
      { method: 'POST', path: /./, reply: () => ok({}) },
    ]);
    await new MilvusAdapter({ fetch, token: 'root:Milvus' }).createCollection('hr-docs', {
      dimensions: 3,
      distanceMetric: 'dot',
      embeddingProvider: 'openai',
      embeddingModel: 'openai/m',
    });
    const create = calls.find(
      (c) =>
        c.path.endsWith('/collections/create') &&
        (c.body as { collectionName: string }).collectionName === 'hr_docs',
    )!;
    const body = create.body as Record<string, any>;
    expect(create.headers['Authorization']).toBe('Bearer root:Milvus');
    expect(body['dbName']).toBe('default');
    expect(body['schema'].functions).toEqual([
      {
        name: 'content_bm25',
        type: 'BM25',
        inputFieldNames: ['content'],
        outputFieldNames: ['sparse'],
      },
    ]);
    expect(body['indexParams'].map((i: { metricType: string }) => i.metricType)).toEqual([
      'IP',
      'BM25',
    ]);
    expect(body['params']).toEqual({ consistencyLevel: 'Strong' });
  });

  it('builds boolean expressions, including empty-role visibility and JSON fields', async () => {
    const { fetch, calls } = mockFetch([
      has(true),
      meta,
      { method: 'POST', path: /\/entities\/search$/, reply: () => ok([]) },
    ]);
    await new MilvusAdapter({ fetch }).search('docs', [1, 0, 0], 2, {
      tenantId: 'a"b',
      accessRoles: ['hr'],
      tags: ['x'],
      tagsAll: ['y'],
      documentId: 'd',
      metadata: { dept: 'hr', level: 2 },
    });
    const search = calls.find((c) => c.path.endsWith('/entities/search'))!.body as Record<
      string,
      unknown
    >;
    expect(search['annsField']).toBe('dense');
    expect(search['filter']).toBe(
      'tenantId == "a\\"b" and (array_length(accessRoles) == 0 or array_contains_any(accessRoles, ["hr", "*"])) ' +
        'and array_contains_any(tags, ["x"]) and array_contains_all(tags, ["y"]) and documentId in ["d"] ' +
        'and custom["dept"] == "hr" and custom["level"] == 2',
    );
  });

  it('reports errors carried in a 200 response', async () => {
    const { fetch } = mockFetch([
      {
        method: 'POST',
        path: /\/collections\/has$/,
        reply: () => ({ code: 1100, message: 'invalid parameter' }),
      },
    ]);
    await expect(new MilvusAdapter({ fetch }).collectionExists('docs')).rejects.toThrow(
      /code 1100.*invalid parameter/,
    );
  });

  it('reads arrays in either plain or protobuf-wrapped form', async () => {
    const { fetch } = mockFetch([
      has(true),
      meta,
      {
        method: 'POST',
        path: /\/entities\/search$/,
        reply: () =>
          ok([
            {
              id: 'a',
              content: 'x',
              distance: 1,
              accessRoles: { Data: { StringData: { data: ['hr'] } } },
              tags: ['t'],
              custom: '{"k":"v"}',
            },
          ]),
      },
    ]);
    const [top] = await new MilvusAdapter({ fetch }).search('docs', [1], 1);
    expect(top).toMatchObject({ id: 'a', score: 1 });
    expect(top!.metadata).toMatchObject({ accessRoles: ['hr'], tags: ['t'], custom: { k: 'v' } });
  });

  it('pages scans by primary key', async () => {
    const filters: string[] = [];
    const { fetch } = mockFetch([
      {
        method: 'POST',
        path: /\/entities\/query$/,
        reply: (req) => {
          const filter = (req.body as { filter: string }).filter;
          filters.push(filter);
          if (!filter.includes('id >')) {
            return ok(
              Array.from({ length: 1000 }, (_, i) => ({
                id: `a${String(i).padStart(4, '0')}`,
                documentId: 'd1',
              })),
            );
          }
          return ok([{ id: 'b', documentId: 'd2' }]);
        },
      },
    ]);
    expect((await new MilvusAdapter({ fetch }).listDocumentIds('docs')).sort()).toEqual([
      'd1',
      'd2',
    ]);
    expect(filters[1]).toBe('(id != "") and (id > "a0999")');
  });

  it('rejects invalid names and empty bulk filters', async () => {
    const { fetch } = mockFetch([]);
    const store = new MilvusAdapter({ fetch });
    await expect(store.collectionExists('a/b')).rejects.toThrow(/letters, digits/);
    await expect(store.updateDocumentsMetadata('docs', {}, { tags: ['x'] })).rejects.toThrow(
      /empty filter/,
    );
  });
});
