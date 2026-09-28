/**
 * Unit tests for the document-level operations added to the VectorStoreAdapter
 * contract: deleteCollection, removeDocumentsByFilter, updateDocumentsMetadata,
 * listDocumentIds, and the new RAGFilter fields (tagsAll, documentId).
 *
 * Exercised against InMemoryVectorStore (the reference implementation).
 * MeilisearchAdapter is covered by tests/integration/meilisearch.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { SDKError } from '../../../src/errors/index.js';
import type { VectorDocument, CollectionConfig } from '../../../src/rag/types.js';

const CONFIG: CollectionConfig = {
  dimensions: 3,
  distanceMetric: 'cosine',
  embeddingProvider: 'openai',
  embeddingModel: 'openai/text-embedding-3-small',
};

const COLLECTION = 'docs';

function chunk(
  id: string,
  documentId: string,
  overrides: Partial<VectorDocument['metadata']> = {},
): VectorDocument {
  return {
    id,
    content: `Content of ${id}`,
    vector: [1, 0, 0],
    metadata: { documentId, tenantId: 'acme', ...overrides },
  };
}

let store: InMemoryVectorStore;

beforeEach(async () => {
  store = new InMemoryVectorStore();
  await store.createCollection(COLLECTION, CONFIG);
  await store.upsert(COLLECTION, [
    chunk('a_0', 'docA', { tags: ['cat:policy', 'cf_area:legal'], accessRoles: ['role1'] }),
    chunk('a_1', 'docA', { tags: ['cat:policy', 'cf_area:legal'], accessRoles: ['role1'] }),
    chunk('b_0', 'docB', { tags: ['cat:policy', 'cf_area:hr'], accessRoles: ['role2'] }),
    chunk('c_0', 'docC', { tags: ['cat:contract'], accessRoles: [] }),
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// RAGFilter: tagsAll (AND) and documentId
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGFilter.tagsAll', () => {
  it('matches only documents carrying ALL listed tags', async () => {
    const hits = await store.search(COLLECTION, [1, 0, 0], 10, {
      tagsAll: ['cat:policy', 'cf_area:legal'],
    });
    expect(hits.map((h) => h.id).sort()).toEqual(['a_0', 'a_1']);
  });

  it('combines with tags (OR): both conditions must hold', async () => {
    const hits = await store.search(COLLECTION, [1, 0, 0], 10, {
      tags: ['cf_area:hr', 'cf_area:legal'],
      tagsAll: ['cat:policy'],
    });
    expect(hits.map((h) => h.id).sort()).toEqual(['a_0', 'a_1', 'b_0']);
  });
});

describe('RAGFilter.documentId', () => {
  it('matches a single document by ID', async () => {
    const hits = await store.search(COLLECTION, [1, 0, 0], 10, { documentId: 'docA' });
    expect(hits.map((h) => h.id).sort()).toEqual(['a_0', 'a_1']);
  });

  it('matches any of a list of document IDs', async () => {
    const hits = await store.search(COLLECTION, [1, 0, 0], 10, {
      documentId: ['docB', 'docC'],
    });
    expect(hits.map((h) => h.id).sort()).toEqual(['b_0', 'c_0']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeDocumentsByFilter
// ─────────────────────────────────────────────────────────────────────────────

describe('removeDocumentsByFilter()', () => {
  it('removes every chunk matching the filter and reports the count', async () => {
    const res = await store.removeDocumentsByFilter(COLLECTION, { documentId: 'docA' });
    expect(res.removed).toBe(2);
    const info = await store.collectionInfo(COLLECTION);
    expect(info.documentCount).toBe(2);
    const left = await store.search(COLLECTION, [1, 0, 0], 10);
    expect(left.map((h) => h.id).sort()).toEqual(['b_0', 'c_0']);
  });

  it('rejects an empty filter (mass-deletion guard)', async () => {
    await expect(store.removeDocumentsByFilter(COLLECTION, {})).rejects.toThrow(SDKError);
    const info = await store.collectionInfo(COLLECTION);
    expect(info.documentCount).toBe(4);
  });

  it('treats an empty documentId array as an empty filter', async () => {
    await expect(store.removeDocumentsByFilter(COLLECTION, { documentId: [] })).rejects.toThrow(
      SDKError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateDocumentsMetadata
// ─────────────────────────────────────────────────────────────────────────────

describe('updateDocumentsMetadata()', () => {
  it('re-stamps accessRoles on matching chunks without touching content or vectors', async () => {
    const res = await store.updateDocumentsMetadata(
      COLLECTION,
      { documentId: 'docA' },
      { accessRoles: ['role1', 'role9'] },
    );
    expect(res.updated).toBe(2);

    const hits = await store.search(COLLECTION, [1, 0, 0], 10, { documentId: 'docA' });
    for (const h of hits) {
      expect(h.metadata.accessRoles).toEqual(['role1', 'role9']);
      expect(h.metadata.updatedAt).toBeInstanceOf(Date);
      expect(h.content).toMatch(/^Content of /);
    }

    // Unmatched documents are untouched.
    const other = await store.search(COLLECTION, [1, 0, 0], 10, { documentId: 'docB' });
    expect(other[0]!.metadata.accessRoles).toEqual(['role2']);
  });

  it('the updated accessRoles take effect in subsequent filtered searches', async () => {
    await store.updateDocumentsMetadata(
      COLLECTION,
      { documentId: 'docB' },
      { accessRoles: ['roleX'] },
    );
    const before = await store.search(COLLECTION, [1, 0, 0], 10, {
      accessRoles: ['role2'],
      documentId: 'docB',
    });
    expect(before).toHaveLength(0);
    const after = await store.search(COLLECTION, [1, 0, 0], 10, {
      accessRoles: ['roleX'],
      documentId: 'docB',
    });
    expect(after).toHaveLength(1);
  });

  it('ignores non-patchable fields and rejects an empty filter', async () => {
    await expect(
      store.updateDocumentsMetadata(COLLECTION, {}, { accessRoles: ['x'] }),
    ).rejects.toThrow(SDKError);

    const res = await store.updateDocumentsMetadata(
      COLLECTION,
      { documentId: 'docC' },
      // documentId/chunkIndex are immutable — only patchable fields are applied.
      { documentId: 'HACK', chunkIndex: 99, tags: ['cat:renamed'] } as never,
    );
    expect(res.updated).toBe(1);
    const hits = await store.search(COLLECTION, [1, 0, 0], 10, { documentId: 'docC' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata.tags).toEqual(['cat:renamed']);
    expect(hits[0]!.metadata.chunkIndex).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listDocumentIds / deleteCollection
// ─────────────────────────────────────────────────────────────────────────────

describe('listDocumentIds()', () => {
  it('returns the distinct source-document IDs', async () => {
    const ids = await store.listDocumentIds(COLLECTION);
    expect(ids.sort()).toEqual(['docA', 'docB', 'docC']);
  });
});

describe('deleteCollection()', () => {
  it('deletes the collection and all its data', async () => {
    await store.deleteCollection(COLLECTION);
    expect(await store.collectionExists(COLLECTION)).toBe(false);
  });

  it('is a no-op for a collection that does not exist', async () => {
    await expect(store.deleteCollection('nope')).resolves.toBeUndefined();
  });
});
