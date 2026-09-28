import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { SDKError } from '../../../src/errors/index.js';
import type { VectorDocument, CollectionConfig } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_CONFIG: CollectionConfig = {
  dimensions: 3,
  distanceMetric: 'cosine',
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small',
};

const COLLECTION = 'test-docs';

/**
 * Unit vectors for deterministic cosine similarity:
 * cos([1,0,0], [1,0,0]) = 1  →  normalised score = 1
 * cos([1,0,0], [0,1,0]) = 0  →  normalised score = 0.5
 * cos([1,0,0], [-1,0,0]) = -1 → normalised score = 0
 */
function makeDoc(
  id: string,
  vector: number[],
  content = `Content ${id}`,
  overrides: Partial<VectorDocument['metadata']> = {},
): VectorDocument {
  return {
    id,
    content,
    vector,
    metadata: { documentId: id, ...overrides },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────────────────────

  describe('identity', () => {
    it('has name "in-memory"', () => {
      expect(store.name).toBe('in-memory');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Collection management
  // ─────────────────────────────────────────────────────────────────────────

  describe('createCollection()', () => {
    it('creates a collection', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      expect(await store.collectionExists(COLLECTION)).toBe(true);
    });

    it('replaces an existing collection (erases documents)', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0])]);
      // Recreate — should be empty
      await store.createCollection(COLLECTION, BASE_CONFIG);
      const info = await store.collectionInfo(COLLECTION);
      expect(info.documentCount).toBe(0);
    });
  });

  describe('collectionExists()', () => {
    it('returns false for non-existent collection', async () => {
      expect(await store.collectionExists('ghost')).toBe(false);
    });

    it('returns true after creation', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      expect(await store.collectionExists(COLLECTION)).toBe(true);
    });
  });

  describe('collectionInfo()', () => {
    it('returns correct metadata', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0]), makeDoc('b', [0, 1, 0])]);
      const info = await store.collectionInfo(COLLECTION);
      expect(info).toEqual({
        name: COLLECTION,
        documentCount: 2,
        dimensions: 3,
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
        distanceMetric: 'cosine',
      });
    });

    it('throws when collection does not exist', async () => {
      await expect(store.collectionInfo('ghost')).rejects.toThrow(SDKError);
    });
  });

  describe('healthCheck()', () => {
    it('always returns true', async () => {
      expect(await store.healthCheck()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Ingestion
  // ─────────────────────────────────────────────────────────────────────────

  describe('upsert()', () => {
    it('inserts documents', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0])]);
      const info = await store.collectionInfo(COLLECTION);
      expect(info.documentCount).toBe(1);
    });

    it('replaces existing document with same id', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'original')]);
      await store.upsert(COLLECTION, [makeDoc('a', [0, 1, 0], 'updated')]);
      const info = await store.collectionInfo(COLLECTION);
      expect(info.documentCount).toBe(1);
      const results = await store.search(COLLECTION, [0, 1, 0], 1);
      expect(results[0].content).toBe('updated');
    });

    it('throws when collection does not exist', async () => {
      await expect(store.upsert('ghost', [makeDoc('a', [1, 0, 0])])).rejects.toThrow(SDKError);
    });
  });

  describe('delete()', () => {
    it('removes documents by id', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0]), makeDoc('b', [0, 1, 0])]);
      await store.delete(COLLECTION, ['a']);
      const info = await store.collectionInfo(COLLECTION);
      expect(info.documentCount).toBe(1);
    });

    it('silently ignores non-existent ids', async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0])]);
      await expect(store.delete(COLLECTION, ['nonexistent'])).resolves.not.toThrow();
    });

    it('throws when collection does not exist', async () => {
      await expect(store.delete('ghost', ['a'])).rejects.toThrow(SDKError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // search() — cosine similarity
  // ─────────────────────────────────────────────────────────────────────────

  describe('search()', () => {
    beforeEach(async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
    });

    it('returns the most similar document first', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('exact', [1, 0, 0]), // cos = 1 → score = 1
        makeDoc('ortho', [0, 1, 0]), // cos = 0 → score = 0.5
        makeDoc('opposite', [-1, 0, 0]), // cos = -1 → score = 0
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10);
      expect(results[0].id).toBe('exact');
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });

    it('excludes passages with score = 0 (orthogonal or opposing)', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('zero', [0, 1, 0]), // cos([1,0,0],[0,1,0]) = 0 → score = 0.5 ≠ 0
        makeDoc('opposite', [-1, 0, 0]), // cos = -1 → score = 0 → EXCLUDED
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10);
      // opposite score = 0 should be excluded
      expect(results.find((p) => p.id === 'opposite')).toBeUndefined();
    });

    it('respects topK limit', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0]),
        makeDoc('b', [0.9, 0.1, 0]),
        makeDoc('c', [0.8, 0.2, 0]),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 2);
      expect(results).toHaveLength(2);
    });

    it('returns empty array when collection is empty', async () => {
      expect(await store.search(COLLECTION, [1, 0, 0], 5)).toEqual([]);
    });

    it('returns Passage with collection name set', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0])]);
      const [result] = await store.search(COLLECTION, [1, 0, 0], 1);
      expect(result.collection).toBe(COLLECTION);
    });

    it('throws when collection does not exist', async () => {
      await expect(store.search('ghost', [1, 0, 0], 5)).rejects.toThrow(SDKError);
    });

    // Filters
    it('filters by tenantId', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('t1', [1, 0, 0], 'doc t1', { tenantId: 'tenant-a' }),
        makeDoc('t2', [1, 0, 0], 'doc t2', { tenantId: 'tenant-b' }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, { tenantId: 'tenant-a' });
      expect(results.every((p) => p.metadata.tenantId === 'tenant-a')).toBe(true);
      expect(results.find((p) => p.id === 't2')).toBeUndefined();
    });

    it('filters by language', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('en', [1, 0, 0], 'hello', { language: 'en' }),
        makeDoc('es', [1, 0, 0], 'hola', { language: 'es' }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, { language: 'en' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('en');
    });

    it('filters by tags (OR semantics)', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'a', { tags: ['finance', 'report'] }),
        makeDoc('b', [1, 0, 0], 'b', { tags: ['hr'] }),
        makeDoc('c', [1, 0, 0], 'c', { tags: ['finance'] }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, {
        tags: ['finance'],
      });
      expect(results.map((p) => p.id).sort()).toEqual(['a', 'c']);
    });

    it('filters by accessRoles (overlap)', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('admin-doc', [1, 0, 0], 'a', { accessRoles: ['admin'] }),
        makeDoc('user-doc', [1, 0, 0], 'b', { accessRoles: ['user', 'viewer'] }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, {
        accessRoles: ['admin'],
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('admin-doc');
    });

    it('filters by dateRange.from', async () => {
      const jan = new Date('2026-01-01');
      const feb = new Date('2026-02-01');
      const mar = new Date('2026-03-01');
      await store.upsert(COLLECTION, [
        makeDoc('jan', [1, 0, 0], 'jan', { createdAt: jan }),
        makeDoc('mar', [1, 0, 0], 'mar', { createdAt: mar }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, {
        dateRange: { from: feb },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mar');
    });

    it('filters by metadata key-value (custom fields)', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'a', { custom: { region: 'us-east' } }),
        makeDoc('b', [1, 0, 0], 'b', { custom: { region: 'eu-west' } }),
      ]);
      const results = await store.search(COLLECTION, [1, 0, 0], 10, {
        metadata: { region: 'us-east' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // keywordSearch() — token overlap
  // ─────────────────────────────────────────────────────────────────────────

  describe('keywordSearch()', () => {
    beforeEach(async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
    });

    it('returns documents containing query tokens', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'quarterly earnings report for 2025'),
        makeDoc('b', [0, 1, 0], 'employee performance review'),
        makeDoc('c', [0, 0, 1], 'quarterly performance metrics'),
      ]);
      const results = await store.keywordSearch(COLLECTION, 'quarterly', 10);
      const ids = results.map((p) => p.id);
      expect(ids).toContain('a');
      expect(ids).toContain('c');
      expect(ids).not.toContain('b');
    });

    it('scores are normalised to [0, 1]', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('full-match', [1, 0, 0], 'hello world'),
        makeDoc('partial', [0, 1, 0], 'hello there friend'),
      ]);
      const results = await store.keywordSearch(COLLECTION, 'hello world', 10);
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('ranks full-match above partial match', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('partial', [0, 1, 0], 'hello there'),
        makeDoc('full', [1, 0, 0], 'hello world'),
      ]);
      const results = await store.keywordSearch(COLLECTION, 'hello world', 10);
      expect(results[0].id).toBe('full');
    });

    it('is case-insensitive', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'Hello World')]);
      const results = await store.keywordSearch(COLLECTION, 'hello world', 10);
      expect(results).toHaveLength(1);
    });

    it('excludes documents with zero token overlap', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'completely unrelated text')]);
      const results = await store.keywordSearch(COLLECTION, 'quarterly earnings', 10);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for empty query', async () => {
      await store.upsert(COLLECTION, [makeDoc('a', [1, 0, 0], 'some text')]);
      const results = await store.keywordSearch(COLLECTION, '', 10);
      expect(results).toHaveLength(0);
    });

    it('respects topK', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'hello world foo'),
        makeDoc('b', [0, 1, 0], 'hello world bar'),
        makeDoc('c', [0, 0, 1], 'hello world baz'),
      ]);
      const results = await store.keywordSearch(COLLECTION, 'hello', 2);
      expect(results).toHaveLength(2);
    });

    it('applies filters', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'hello world', { language: 'en' }),
        makeDoc('b', [0, 1, 0], 'hello world', { language: 'es' }),
      ]);
      const results = await store.keywordSearch(COLLECTION, 'hello', 10, { language: 'en' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('a');
    });

    it('throws when collection does not exist', async () => {
      await expect(store.keywordSearch('ghost', 'query', 5)).rejects.toThrow(SDKError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // hybridSearch() — RRF fusion
  // ─────────────────────────────────────────────────────────────────────────

  describe('hybridSearch()', () => {
    beforeEach(async () => {
      await store.createCollection(COLLECTION, BASE_CONFIG);
    });

    it('includes results from both vector and keyword searches', async () => {
      // 'vector-best' is best by vector; 'keyword-best' is best by keyword
      await store.upsert(COLLECTION, [
        makeDoc('vector-best', [1, 0, 0], 'unrelated content here'),
        makeDoc('keyword-best', [0, 1, 0], 'hello world'),
        makeDoc('both-match', [0.9, 0.1, 0], 'hello vector'),
      ]);
      const results = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello', 10, 0.5);
      const ids = results.map((p) => p.id);
      expect(ids).toContain('vector-best');
      expect(ids).toContain('keyword-best');
    });

    it('alpha=1 gives results closest to pure vector search', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('vector-win', [1, 0, 0], 'xyz'), // best by cosine
        makeDoc('keyword-win', [0, 0, 1], 'hello world'), // best by keyword
      ]);
      const hybrid = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello world', 2, 1.0);
      // alpha=1 → keyword contribution = 0 → vector-win should rank first
      expect(hybrid[0].id).toBe('vector-win');
    });

    it('alpha=0 gives results closest to pure keyword search', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('vector-win', [1, 0, 0], 'xyz'),
        makeDoc('keyword-win', [0, 0, 1], 'hello world'),
      ]);
      const hybrid = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello world', 2, 0.0);
      // keyword-win should rank first when alpha=0
      expect(hybrid[0].id).toBe('keyword-win');
    });

    it('deduplicates passages appearing in both result sets', async () => {
      await store.upsert(COLLECTION, [makeDoc('shared', [1, 0, 0], 'hello world')]);
      const results = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello', 10, 0.5);
      const ids = results.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('respects topK', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'hello'),
        makeDoc('b', [0.9, 0, 0.1], 'hello world'),
        makeDoc('c', [0.8, 0.1, 0.1], 'hello foo'),
      ]);
      const results = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello', 2, 0.5);
      expect(results).toHaveLength(2);
    });

    it('applies filters', async () => {
      await store.upsert(COLLECTION, [
        makeDoc('a', [1, 0, 0], 'hello world', { tenantId: 'tenant-a' }),
        makeDoc('b', [1, 0, 0], 'hello world', { tenantId: 'tenant-b' }),
      ]);
      const results = await store.hybridSearch(COLLECTION, [1, 0, 0], 'hello', 10, 0.5, {
        tenantId: 'tenant-a',
      });
      expect(results.every((p) => p.metadata.tenantId === 'tenant-a')).toBe(true);
    });

    it('throws when collection does not exist', async () => {
      await expect(store.hybridSearch('ghost', [1, 0, 0], 'query', 5, 0.7)).rejects.toThrow(
        SDKError,
      );
    });

    it('returns empty array when store is empty', async () => {
      const results = await store.hybridSearch(COLLECTION, [1, 0, 0], 'query', 10, 0.5);
      expect(results).toHaveLength(0);
    });
  });
});
