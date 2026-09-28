import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeilisearchAdapter } from '../../../src/rag/vectorstore/MeilisearchAdapter.js';
import type { VectorDocument } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock the meilisearch SDK
// ─────────────────────────────────────────────────────────────────────────────

// Capture search params for assertions
let lastSearchParams: Record<string, unknown> = {};
let lastAddedDocs: unknown[] = [];

/** Wraps a resolved value with a .waitTask() method (mimics EnqueuedTaskPromise). */
function enqueuedTask<T>(value: T): Promise<T> & { waitTask: () => Promise<void> } {
  const p = Promise.resolve(value) as Promise<T> & { waitTask: () => Promise<void> };
  p.waitTask = () => Promise.resolve();
  return p;
}

const mockSearch = vi.fn().mockReturnValue(Promise.resolve({ hits: [] }));
const mockAddDocuments = vi.fn().mockReturnValue(enqueuedTask({}));
const mockDeleteDocuments = vi.fn().mockReturnValue(enqueuedTask({}));
const mockUpdateSettings = vi.fn().mockReturnValue(enqueuedTask({}));
const mockUpdateEmbedders = vi.fn().mockReturnValue(enqueuedTask({}));
const mockGetStats = vi.fn().mockResolvedValue({ numberOfDocuments: 5 });

const mockIndex = {
  search: (q: string, params: Record<string, unknown>) => {
    lastSearchParams = { q, ...params };
    return mockSearch(q, params);
  },
  addDocuments: (docs: unknown[], opts: unknown) => {
    lastAddedDocs = docs;
    return mockAddDocuments(docs, opts);
  },
  deleteDocuments: mockDeleteDocuments,
  updateSettings: mockUpdateSettings,
  updateEmbedders: mockUpdateEmbedders,
  getStats: mockGetStats,
};

const mockCreateIndex = vi.fn().mockReturnValue(enqueuedTask({}));
const mockDeleteIndex = vi.fn().mockReturnValue(enqueuedTask({}));
const mockGetIndex = vi.fn().mockResolvedValue(mockIndex);
const mockIsHealthy = vi.fn().mockResolvedValue(true);

vi.mock('meilisearch', () => ({
  MeiliSearch: vi.fn().mockImplementation(() => ({
    createIndex: mockCreateIndex,
    deleteIndex: mockDeleteIndex,
    getIndex: mockGetIndex,
    isHealthy: mockIsHealthy,
    index: () => mockIndex,
  })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<VectorDocument> = {}): VectorDocument {
  return {
    id: 'doc_chunk_0',
    content: 'Test content',
    vector: [0.1, 0.2, 0.3, 0.4],
    metadata: {
      documentId: 'doc-1',
      tenantId: 'acme',
      tags: ['hr'],
      accessRoles: ['employee'],
      title: 'Test doc',
      source: '/docs/test.md',
      createdAt: new Date('2024-01-01'),
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MeilisearchAdapter', () => {
  let adapter: MeilisearchAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    lastSearchParams = {};
    lastAddedDocs = [];
    mockSearch.mockReturnValue(Promise.resolve({ hits: [] }));
    mockAddDocuments.mockReturnValue(enqueuedTask({}));
    mockDeleteDocuments.mockReturnValue(enqueuedTask({}));
    mockUpdateSettings.mockReturnValue(enqueuedTask({}));
    mockCreateIndex.mockReturnValue(enqueuedTask({}));
    mockDeleteIndex.mockReturnValue(enqueuedTask({}));
    mockIsHealthy.mockResolvedValue(true);
    adapter = new MeilisearchAdapter({ url: 'http://localhost:7700', apiKey: 'test-key' });
  });

  // ── TC-MEILI-01: hybridSearch uses semanticRatio ─────────────────────────

  it('TC-MEILI-01: hybridSearch passes alpha directly as semanticRatio', async () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    await adapter.hybridSearch('col', vector, 'hello world', 5, 0.7);

    expect(lastSearchParams['q']).toBe('hello world');
    expect(lastSearchParams['vector']).toEqual(vector);
    expect(lastSearchParams['hybrid']).toEqual({ semanticRatio: 0.7, embedder: 'default' });
    expect(lastSearchParams['limit']).toBe(5);
  });

  it('TC-MEILI-01: hybridSearch alpha=0.3 maps to semanticRatio=0.3', async () => {
    await adapter.hybridSearch('col', [0.1], 'query', 3, 0.3);
    expect((lastSearchParams['hybrid'] as Record<string, number>)['semanticRatio']).toBe(0.3);
  });

  // ── TC-MEILI-02: Tenant filter ───────────────────────────────────────────

  it('TC-MEILI-02: buildFilter includes tenantId condition', async () => {
    await adapter.search('col', [0.1], 5, { tenantId: 'acme' });
    expect(lastSearchParams['filter']).toBe("tenantId = 'acme'");
  });

  it('TC-MEILI-02: buildFilter combines tenantId with other conditions using AND', async () => {
    await adapter.search('col', [0.1], 5, { tenantId: 'acme', language: 'es' });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("tenantId = 'acme'");
    expect(f).toContain("language = 'es'");
    expect(f).toContain(' AND ');
  });

  // ── TC-MEILI-03: accessRoles includes wildcard and empty check ───────────

  it('TC-MEILI-03: buildFilter adds wildcard and empty check for accessRoles', async () => {
    await adapter.search('col', [0.1], 5, { accessRoles: ['employee'] });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("accessRoles IN ['employee', '*']");
    expect(f).toContain('OR accessRoles IS EMPTY');
  });

  it('TC-MEILI-03: multiple roles all appear in filter with wildcard', async () => {
    await adapter.search('col', [0.1], 5, { accessRoles: ['hr_admin', 'manager'] });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("'hr_admin'");
    expect(f).toContain("'manager'");
    expect(f).toContain("'*'");
    expect(f).toContain('OR accessRoles IS EMPTY');
  });

  // ── TC-MEILI-04: upsert converts VectorDocument to _vectors format ───────

  it('TC-MEILI-04: upsert sends _vectors.default with the embedding vector', async () => {
    const doc = makeDoc({ vector: [0.1, 0.2, 0.3, 0.4] });
    await adapter.upsert('col', [doc]);

    expect(lastAddedDocs).toHaveLength(1);
    const uploaded = lastAddedDocs[0] as Record<string, unknown>;
    expect(uploaded['_vectors']).toEqual({ default: [0.1, 0.2, 0.3, 0.4] });
    expect(uploaded['content']).toBe('Test content');
  });

  it('TC-MEILI-04: upsert populates all filterable metadata fields', async () => {
    const doc = makeDoc();
    await adapter.upsert('col', [doc]);

    const uploaded = lastAddedDocs[0] as Record<string, unknown>;
    expect(uploaded['tenantId']).toBe('acme');
    expect(uploaded['tags']).toEqual(['hr']);
    expect(uploaded['accessRoles']).toEqual(['employee']);
    expect(uploaded['documentId']).toBe('doc-1');
    expect(uploaded['title']).toBe('Test doc');
    expect(typeof uploaded['createdAt']).toBe('number');
  });

  it('TC-MEILI-04: upsert converts createdAt Date to timestamp number', async () => {
    const date = new Date('2024-06-15T10:00:00Z');
    const doc = makeDoc({ metadata: { documentId: 'x', createdAt: date } });
    await adapter.upsert('col', [doc]);

    const uploaded = lastAddedDocs[0] as Record<string, unknown>;
    expect(uploaded['createdAt']).toBe(date.getTime());
  });

  // ── TC-MEILI-05: createCollection configures correct settings ───────────

  it('TC-MEILI-05: createCollection applies filterableAttributes including tenantId, accessRoles, tags', async () => {
    await adapter.createCollection('test', {
      dimensions: 4,
      distanceMetric: 'cosine',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
    });

    expect(mockCreateIndex).toHaveBeenCalledWith('test', { primaryKey: 'id' });
    expect(mockUpdateSettings).toHaveBeenCalledOnce();
    const [settings] = mockUpdateSettings.mock.calls[0] as [Record<string, unknown>];
    const filterable = settings['filterableAttributes'] as string[];
    expect(filterable).toContain('tenantId');
    expect(filterable).toContain('accessRoles');
    expect(filterable).toContain('tags');
    const searchable = settings['searchableAttributes'] as string[];
    expect(searchable).toContain('content');
    expect(searchable).toContain('title');
    const sortable = settings['sortableAttributes'] as string[];
    expect(sortable).toContain('createdAt');

    // Verify embedder configured for userProvided vectors
    expect(mockUpdateEmbedders).toHaveBeenCalledWith({
      default: { source: 'userProvided', dimensions: 4 },
    });
  });

  // ── TC-MEILI-06: deleteCollection removes the index ─────────────────────

  it('TC-MEILI-06: deleteCollection calls deleteIndex with the collection name', async () => {
    await adapter.deleteCollection('test-index');
    expect(mockDeleteIndex).toHaveBeenCalledWith('test-index');
  });

  it('TC-MEILI-06: collectionExists returns false when getIndex throws', async () => {
    mockGetIndex.mockRejectedValueOnce(new Error('index not found'));
    const exists = await adapter.collectionExists('gone-col');
    expect(exists).toBe(false);
  });

  // ── TC-MEILI-07: search uses semanticRatio=1.0 ─────────────────────────

  it('TC-MEILI-07: search sends semanticRatio=1.0 and empty query string', async () => {
    const vector = [0.1, 0.2, 0.3];
    await adapter.search('col', vector, 5);

    expect(lastSearchParams['q']).toBe('');
    expect(lastSearchParams['vector']).toEqual(vector);
    expect((lastSearchParams['hybrid'] as Record<string, number>)['semanticRatio']).toBe(1.0);
  });

  // ── TC-MEILI-08: keywordSearch uses semanticRatio=0.0 and no vector ─────

  it('TC-MEILI-08: keywordSearch sends semanticRatio=0.0 without vector field', async () => {
    await adapter.keywordSearch('col', 'vacation policy', 5);

    expect(lastSearchParams['q']).toBe('vacation policy');
    expect(lastSearchParams['vector']).toBeUndefined();
    expect((lastSearchParams['hybrid'] as Record<string, number>)['semanticRatio']).toBe(0.0);
  });

  // ── TC-MEILI-09: Escape of special characters in filter values ──────────

  it('TC-MEILI-09: escapes single quotes in tenantId filter value', async () => {
    await adapter.search('col', [0.1], 5, { tenantId: "O'Brien Corp" });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("tenantId = 'O''Brien Corp'");
  });

  it('TC-MEILI-09: escapes single quotes in accessRoles filter', async () => {
    await adapter.search('col', [0.1], 5, { accessRoles: ["it's-a-role"] });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("'it''s-a-role'");
  });

  it('TC-MEILI-09: escapes single quotes in tags filter', async () => {
    await adapter.search('col', [0.1], 5, { tags: ["tag'with'quotes"] });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("'tag''with''quotes'");
  });

  // ── TC-MEILI-10: healthCheck ─────────────────────────────────────────────

  it('TC-MEILI-10: healthCheck returns true when isHealthy returns true', async () => {
    mockIsHealthy.mockResolvedValueOnce(true);
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('TC-MEILI-10: healthCheck returns false when isHealthy returns false', async () => {
    mockIsHealthy.mockResolvedValueOnce(false);
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('TC-MEILI-10: healthCheck returns false when isHealthy throws', async () => {
    mockIsHealthy.mockRejectedValueOnce(new Error('connection refused'));
    expect(await adapter.healthCheck()).toBe(false);
  });

  // ── Additional coverage ───────────────────────────────────────────────────

  it('collectionExists returns true when getIndex resolves', async () => {
    mockGetIndex.mockResolvedValueOnce(mockIndex);
    expect(await adapter.collectionExists('exists-col')).toBe(true);
  });

  it('collectionInfo returns documentCount from stats', async () => {
    mockGetIndex.mockResolvedValueOnce(mockIndex);
    mockGetStats.mockResolvedValueOnce({ numberOfDocuments: 42 });
    const info = await adapter.collectionInfo('my-col');
    expect(info.name).toBe('my-col');
    expect(info.documentCount).toBe(42);
  });

  it('delete calls deleteDocuments with the given ids', async () => {
    await adapter.delete('col', ['id1', 'id2']);
    expect(mockDeleteDocuments).toHaveBeenCalledWith(['id1', 'id2']);
  });

  it('delete skips empty id list without calling the API', async () => {
    await adapter.delete('col', []);
    expect(mockDeleteDocuments).not.toHaveBeenCalled();
  });

  it('search returns empty array when Meilisearch returns no hits', async () => {
    mockSearch.mockReturnValueOnce(Promise.resolve({ hits: [] }));
    const results = await adapter.search('col', [0.1], 5);
    expect(results).toEqual([]);
  });

  it('search maps hits to Passage using _rankingScore', async () => {
    mockSearch.mockReturnValueOnce(
      Promise.resolve({
        hits: [
          {
            id: 'doc_chunk_0',
            content: 'Hello world',
            documentId: 'doc-1',
            tenantId: 'acme',
            tags: ['hr'],
            accessRoles: ['employee'],
            title: 'My doc',
            source: '/path.md',
            language: 'es',
            author: 'Alice',
            createdAt: 1700000000000,
            updatedAt: 1700000001000,
            chunkIndex: 0,
            totalChunks: 1,
            _rankingScore: 0.92,
          },
        ],
      }),
    );

    const results = await adapter.search('col', [0.1], 5);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe('doc_chunk_0');
    expect(r.content).toBe('Hello world');
    expect(r.score).toBe(0.92);
    expect(r.collection).toBe('col');
    expect(r.metadata.tenantId).toBe('acme');
    expect(r.metadata.createdAt).toEqual(new Date(1700000000000));
  });

  it('buildFilter returns undefined (no filter key) when no filter provided', async () => {
    await adapter.search('col', [0.1], 5);
    expect(lastSearchParams['filter']).toBeUndefined();
  });

  it('buildFilter handles dateRange.from and dateRange.to', async () => {
    const from = new Date('2024-01-01');
    const to = new Date('2024-12-31');
    await adapter.search('col', [0.1], 5, { dateRange: { from, to } });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain(`createdAt >= ${from.getTime()}`);
    expect(f).toContain(`createdAt <= ${to.getTime()}`);
  });

  it('buildFilter handles tags with IN clause', async () => {
    await adapter.search('col', [0.1], 5, { tags: ['hr', 'legal'] });
    const f = lastSearchParams['filter'] as string;
    expect(f).toContain("tags IN ['hr', 'legal']");
  });

  it('buildFilter handles language filter', async () => {
    await adapter.search('col', [0.1], 5, { language: 'es' });
    expect(lastSearchParams['filter']).toBe("language = 'es'");
  });

  it('upsert defaults accessRoles to empty array when missing', async () => {
    const doc = makeDoc({ metadata: { documentId: 'x' } });
    await adapter.upsert('col', [doc]);
    const uploaded = lastAddedDocs[0] as Record<string, unknown>;
    expect(uploaded['accessRoles']).toEqual([]);
  });
});
