import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { VectorStoreAdapter } from '../../src/rag/vectorstore/VectorStoreAdapter.js';
import type { VectorDocument, Passage } from '../../src/types/index.js';

/**
 * Behavioural contract every {@link VectorStoreAdapter} must satisfy. The same
 * cases run against the in-memory store (unit tests) and against real engines
 * (integration tests), which is what keeps adapters interchangeable.
 */
export interface ContractOptions {
  /** Adapter supports `keywordSearch` / `hybridSearch`. */
  keyword: boolean;
  /** Adapter supports `filter.metadata` (exact match on `custom` fields). */
  metadataFilter: boolean;
  /** Optional wait after writes, for eventually consistent engines. */
  settle?: () => Promise<void>;
}

const DIMS = 4;

function doc(
  id: string,
  documentId: string,
  content: string,
  vector: number[],
  meta: Partial<VectorDocument['metadata']> = {},
): VectorDocument {
  return {
    id,
    content,
    vector,
    metadata: { documentId, chunkIndex: 0, totalChunks: 1, ...meta },
  };
}

export const CONTRACT_DOCS: VectorDocument[] = [
  doc('doc-a_chunk_0', 'doc-a', 'remote work policy for all employees', [1, 0, 0, 0], {
    tenantId: 'acme',
    accessRoles: [],
    tags: ['hr', 'policy'],
    language: 'en',
    title: 'Remote work',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    custom: { department: 'hr' },
    totalChunks: 2,
  }),
  doc('doc-a_chunk_1', 'doc-a', 'vacation days and paid leave', [0, 0, 1, 0], {
    tenantId: 'acme',
    accessRoles: [],
    tags: ['hr'],
    language: 'en',
    chunkIndex: 1,
    totalChunks: 2,
    createdAt: new Date('2024-01-01T00:00:00Z'),
  }),
  doc('doc-b_chunk_0', 'doc-b', 'salary bands and compensation ranges', [0, 1, 0, 0], {
    tenantId: 'acme',
    accessRoles: ['hr_admin'],
    tags: ['hr', 'salary'],
    language: 'en',
    createdAt: new Date('2024-06-01T00:00:00Z'),
  }),
  doc('doc-c_chunk_0', 'doc-c', 'política de trabajo remoto para la oficina', [0.9, 0.1, 0, 0], {
    tenantId: 'acme',
    accessRoles: ['*'],
    tags: ['it'],
    language: 'es',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  }),
  doc('doc-d_chunk_0', 'doc-d', 'remote work policy at globex', [1, 0, 0, 0], {
    tenantId: 'globex',
    accessRoles: [],
    tags: ['hr'],
    language: 'en',
    createdAt: new Date('2024-03-01T00:00:00Z'),
  }),
];

const ids = (passages: Passage[]): string[] => passages.map((p) => p.id);

/**
 * Registers the contract suite for one adapter.
 *
 * @param label   - Suite name.
 * @param create  - Returns the adapter under test.
 * @param options - Capabilities of the adapter.
 */
export function describeVectorStoreContract(
  label: string,
  create: () => VectorStoreAdapter,
  options: ContractOptions,
): void {
  describe(`${label} — vector store contract`, () => {
    let store: VectorStoreAdapter;
    const collection = `contract_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const settle = async (): Promise<void> => {
      await options.settle?.();
    };

    beforeAll(async () => {
      store = create();
      await store.createCollection(collection, {
        dimensions: DIMS,
        distanceMetric: 'cosine',
        embeddingProvider: 'test',
        embeddingModel: 'test-embedding',
      });
      await store.upsert(collection, CONTRACT_DOCS);
      await settle();
    }, 120_000);

    afterAll(async () => {
      if (store === undefined) return;
      await store.deleteCollection(collection);
      await store.close();
    }, 60_000);

    it('reports health, existence and collection metadata', async () => {
      expect(await store.healthCheck()).toBe(true);
      expect(await store.collectionExists(collection)).toBe(true);
      expect(await store.collectionExists(`${collection}_missing`)).toBe(false);
      const info = await store.collectionInfo(collection);
      expect(info).toMatchObject({
        name: collection,
        documentCount: CONTRACT_DOCS.length,
        dimensions: DIMS,
        distanceMetric: 'cosine',
        embeddingProvider: 'test',
        embeddingModel: 'test-embedding',
      });
    });

    it('ranks by vector similarity with scores in [0, 1]', async () => {
      const results = await store.search(collection, [1, 0, 0, 0], 3, { tenantId: 'acme' });
      expect(ids(results)).toEqual(['doc-a_chunk_0', 'doc-c_chunk_0', expect.any(String)]);
      for (const p of results) {
        expect(p.score).toBeGreaterThanOrEqual(0);
        expect(p.score).toBeLessThanOrEqual(1);
        expect(p.collection).toBe(collection);
      }
      expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    });

    it('round-trips content and metadata', async () => {
      const [top] = await store.search(collection, [1, 0, 0, 0], 1, { tenantId: 'acme' });
      expect(top!.content).toBe('remote work policy for all employees');
      expect(top!.metadata).toMatchObject({
        documentId: 'doc-a',
        tenantId: 'acme',
        tags: ['hr', 'policy'],
        language: 'en',
        title: 'Remote work',
        chunkIndex: 0,
        totalChunks: 2,
      });
      expect(top!.metadata.createdAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('isolates tenants', async () => {
      const results = await store.search(collection, [1, 0, 0, 0], 10, { tenantId: 'globex' });
      expect(ids(results)).toEqual(['doc-d_chunk_0']);
    });

    it('shows public, wildcard and matching-role chunks only', async () => {
      const employee = await store.search(collection, [1, 0, 0, 0], 10, {
        tenantId: 'acme',
        accessRoles: ['employee'],
      });
      expect(ids(employee).sort()).toEqual(['doc-a_chunk_0', 'doc-a_chunk_1', 'doc-c_chunk_0']);

      const admin = await store.search(collection, [1, 0, 0, 0], 10, {
        tenantId: 'acme',
        accessRoles: ['hr_admin'],
      });
      expect(ids(admin)).toContain('doc-b_chunk_0');
    });

    it('filters by tags (any and all), document, language and date', async () => {
      const q = [1, 0, 0, 0];
      const any = await store.search(collection, q, 10, {
        tenantId: 'acme',
        tags: ['salary', 'it'],
      });
      expect(ids(any).sort()).toEqual(['doc-b_chunk_0', 'doc-c_chunk_0']);

      const all = await store.search(collection, q, 10, { tagsAll: ['hr', 'policy'] });
      expect(ids(all)).toEqual(['doc-a_chunk_0']);

      const byDoc = await store.search(collection, q, 10, { documentId: ['doc-a', 'doc-d'] });
      expect(ids(byDoc).sort()).toEqual(['doc-a_chunk_0', 'doc-a_chunk_1', 'doc-d_chunk_0']);

      const spanish = await store.search(collection, q, 10, { language: 'es' });
      expect(ids(spanish)).toEqual(['doc-c_chunk_0']);

      const recent = await store.search(collection, q, 10, {
        tenantId: 'acme',
        dateRange: { from: new Date('2024-05-01T00:00:00Z') },
      });
      expect(ids(recent).sort()).toEqual(['doc-b_chunk_0', 'doc-c_chunk_0']);
    });

    it.runIf(options.metadataFilter)('filters by custom metadata', async () => {
      const results = await store.search(collection, [1, 0, 0, 0], 10, {
        metadata: { department: 'hr' },
      });
      expect(ids(results)).toEqual(['doc-a_chunk_0']);
    });

    it.runIf(options.keyword)('finds chunks by keywords', async () => {
      const results = await store.keywordSearch(collection, 'salary compensation', 5, {
        tenantId: 'acme',
      });
      expect(results[0]?.id).toBe('doc-b_chunk_0');
      for (const p of results) {
        expect(p.score).toBeGreaterThanOrEqual(0);
        expect(p.score).toBeLessThanOrEqual(1);
      }
      const scoped = await store.keywordSearch(collection, 'remote policy', 10, {
        tenantId: 'globex',
      });
      expect(ids(scoped)).toEqual(['doc-d_chunk_0']);
    });

    it.runIf(options.keyword)('combines both signals in hybrid search', async () => {
      const results = await store.hybridSearch(
        collection,
        [0, 0, 1, 0],
        'salary compensation',
        5,
        0.5,
        { tenantId: 'acme' },
      );
      const found = ids(results);
      expect(found).toContain('doc-a_chunk_1'); // vector match
      expect(found).toContain('doc-b_chunk_0'); // keyword match
    });

    it('lists distinct document IDs', async () => {
      expect((await store.listDocumentIds(collection)).sort()).toEqual([
        'doc-a',
        'doc-b',
        'doc-c',
        'doc-d',
      ]);
    });

    it('upserts idempotently', async () => {
      const updated = { ...CONTRACT_DOCS[3]!, content: 'política de trabajo remoto actualizada' };
      await store.upsert(collection, [updated]);
      await settle();
      const info = await store.collectionInfo(collection);
      expect(info.documentCount).toBe(CONTRACT_DOCS.length);
      const [top] = await store.search(collection, [0.9, 0.1, 0, 0], 1, { language: 'es' });
      expect(top!.content).toBe('política de trabajo remoto actualizada');
    });

    it('updates metadata without touching content or vectors', async () => {
      const res = await store.updateDocumentsMetadata(
        collection,
        { documentId: 'doc-a' },
        { tags: ['archived'], accessRoles: ['legal'] },
      );
      expect(res.updated).toBe(2);
      await settle();
      const archived = await store.search(collection, [1, 0, 0, 0], 10, { tags: ['archived'] });
      expect(ids(archived).sort()).toEqual(['doc-a_chunk_0', 'doc-a_chunk_1']);
      expect(archived.find((p) => p.id === 'doc-a_chunk_0')!.content).toBe(
        'remote work policy for all employees',
      );
      const employee = await store.search(collection, [1, 0, 0, 0], 10, {
        tenantId: 'acme',
        accessRoles: ['employee'],
      });
      expect(ids(employee)).not.toContain('doc-a_chunk_0');
      await expect(store.updateDocumentsMetadata(collection, {}, { tags: ['x'] })).rejects.toThrow(
        /empty filter/,
      );
    });

    it('deletes by id and by filter', async () => {
      await store.delete(collection, ['doc-a_chunk_1']);
      await settle();
      expect(ids(await store.search(collection, [0, 0, 1, 0], 10, {}))).not.toContain(
        'doc-a_chunk_1',
      );

      const removed = await store.removeDocumentsByFilter(collection, { documentId: 'doc-b' });
      expect([1, -1]).toContain(removed.removed);
      await settle();
      expect(await store.listDocumentIds(collection)).not.toContain('doc-b');

      await expect(store.removeDocumentsByFilter(collection, {})).rejects.toThrow(/empty filter/);
    });

    it('drops a collection, and dropping a missing one is a no-op', async () => {
      const temp = `${collection}_tmp`;
      await store.createCollection(temp, {
        dimensions: DIMS,
        distanceMetric: 'cosine',
        embeddingProvider: 'test',
        embeddingModel: 'test-embedding',
      });
      expect(await store.collectionExists(temp)).toBe(true);
      await store.deleteCollection(temp);
      expect(await store.collectionExists(temp)).toBe(false);
      await expect(store.deleteCollection(temp)).resolves.toBeUndefined();
    });
  });
}
