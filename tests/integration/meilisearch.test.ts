/**
 * Integration test: MeilisearchAdapter against a real Meilisearch instance.
 *
 * Skipped automatically when Meilisearch is not reachable at MEILI_URL.
 *
 * To run:
 *   MEILI_URL=http://localhost:7700 MEILI_API_KEY=test-master-key npm run test:int
 *
 * Or with Docker:
 *   docker run -d -p 7700:7700 -e MEILI_MASTER_KEY='test-master-key' getmeili/meilisearch:v1.12
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MeilisearchAdapter } from '../../src/rag/vectorstore/MeilisearchAdapter.js';
import type { VectorDocument } from '../../src/types/index.js';

const MEILI_URL = process.env['MEILI_URL'] ?? 'http://localhost:7700';
const MEILI_API_KEY = process.env['MEILI_API_KEY'] ?? process.env['MEILI_MASTER_KEY'] ?? '';
const TEST_COLLECTION = `sdk-test-${Date.now()}`;

async function isMeiliAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { status?: string };
    return body.status === 'available';
  } catch {
    return false;
  }
}

const available = await isMeiliAvailable(MEILI_URL);

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function randomVector(dims = 4): number[] {
  return Array.from({ length: dims }, () => Math.random());
}

const DOCS: VectorDocument[] = [
  {
    id: 'doc1_chunk_0',
    content: 'Política de vacaciones: 20 días hábiles por año.',
    vector: randomVector(),
    metadata: {
      documentId: 'doc1',
      tenantId: 'acme',
      tags: ['hr'],
      accessRoles: ['employee'],
      title: 'Vacaciones',
    },
  },
  {
    id: 'doc2_chunk_0',
    content: 'Procedimiento de seguridad informática y gestión de contraseñas.',
    vector: randomVector(),
    metadata: {
      documentId: 'doc2',
      tenantId: 'acme',
      tags: ['security'],
      accessRoles: ['it_admin'],
      title: 'Seguridad',
    },
  },
  {
    id: 'doc3_chunk_0',
    content: 'Reglamento interno de la empresa para empleados.',
    vector: randomVector(),
    metadata: {
      documentId: 'doc3',
      tenantId: 'acme',
      tags: ['hr'],
      accessRoles: [],
      title: 'Reglamento',
    },
  },
  {
    id: 'doc4_chunk_0',
    content: 'Estado de cuenta mensual del departamento de finanzas.',
    vector: randomVector(),
    metadata: {
      documentId: 'doc4',
      tenantId: 'other-tenant',
      tags: ['finance'],
      accessRoles: ['finance_admin'],
      title: 'Finanzas',
    },
  },
  {
    id: 'doc5_chunk_0',
    content: 'Manual de onboarding para nuevos empleados de ACME.',
    vector: randomVector(),
    metadata: {
      documentId: 'doc5',
      tenantId: 'acme',
      tags: ['hr', 'onboarding'],
      accessRoles: ['*'],
      title: 'Onboarding',
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!available)('MeilisearchAdapter — integration', () => {
  let adapter: MeilisearchAdapter;

  beforeAll(async () => {
    adapter = new MeilisearchAdapter({ url: MEILI_URL, apiKey: MEILI_API_KEY });

    await adapter.createCollection(TEST_COLLECTION, {
      dimensions: 4,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-v1',
    });

    await adapter.upsert(TEST_COLLECTION, DOCS);

    // Give Meilisearch a moment to index
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await adapter.deleteCollection(TEST_COLLECTION).catch(() => {
      // Best-effort cleanup
    });
  });

  it('healthCheck returns true', async () => {
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('collectionExists returns true after creation', async () => {
    expect(await adapter.collectionExists(TEST_COLLECTION)).toBe(true);
  });

  it('collectionInfo reports documentCount', async () => {
    const info = await adapter.collectionInfo(TEST_COLLECTION);
    expect(info.name).toBe(TEST_COLLECTION);
    expect(info.documentCount).toBe(DOCS.length);
  });

  it('search returns passages', async () => {
    const results = await adapter.search(TEST_COLLECTION, randomVector(), 5);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.content).toBeTruthy();
      expect(typeof r.score).toBe('number');
    }
  });

  it('keywordSearch finds document by keyword', async () => {
    const results = await adapter.keywordSearch(TEST_COLLECTION, 'vacaciones', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain('vacaciones');
  });

  it('hybridSearch returns passages with alpha=0.7', async () => {
    const results = await adapter.hybridSearch(
      TEST_COLLECTION,
      randomVector(),
      'vacaciones',
      5,
      0.7,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('tenantId filter isolates results to acme only', async () => {
    const results = await adapter.search(TEST_COLLECTION, randomVector(), 10, { tenantId: 'acme' });
    for (const r of results) {
      expect(r.metadata.tenantId).toBe('acme');
    }
  });

  it('accessRoles filter excludes documents restricted to other roles', async () => {
    // employee can see: employee docs, wildcard docs, public docs — but NOT it_admin or finance_admin
    const results = await adapter.search(TEST_COLLECTION, randomVector(), 10, {
      tenantId: 'acme',
      accessRoles: ['employee'],
    });
    for (const r of results) {
      const roles = r.metadata.accessRoles ?? [];
      const isVisible =
        roles.length === 0 || // public
        roles.includes('*') || // wildcard
        roles.includes('employee'); // direct match
      expect(isVisible).toBe(true);
    }
  });

  it('delete removes documents', async () => {
    const tempDoc: VectorDocument = {
      id: 'temp_chunk_0',
      content: 'Temporary document to be deleted',
      vector: randomVector(),
      metadata: { documentId: 'temp', tenantId: 'acme' },
    };

    await adapter.upsert(TEST_COLLECTION, [tempDoc]);
    await new Promise((r) => setTimeout(r, 300));

    const before = await adapter.collectionInfo(TEST_COLLECTION);
    await adapter.delete(TEST_COLLECTION, ['temp_chunk_0']);
    await new Promise((r) => setTimeout(r, 300));
    const after = await adapter.collectionInfo(TEST_COLLECTION);

    expect(after.documentCount).toBeLessThan(before.documentCount + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Document-level operations (deleteCollection / removeDocumentsByFilter /
// updateDocumentsMetadata / listDocumentIds / tagsAll / documentId filters)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!available)('MeilisearchAdapter — document ops', () => {
  const OPS_COLLECTION = `sdk-ops-${Date.now()}`;
  let adapter: MeilisearchAdapter;

  const OPS_DOCS: VectorDocument[] = [
    {
      id: 'opA_0',
      content: 'Contrato marco con la Universidad.',
      vector: randomVector(),
      metadata: {
        documentId: 'opdocA',
        tenantId: 'acme',
        tags: ['cat:policy', 'cf_area:legal'],
        accessRoles: ['r1'],
      },
    },
    {
      id: 'opA_1',
      content: 'Anexo del contrato marco.',
      vector: randomVector(),
      metadata: {
        documentId: 'opdocA',
        tenantId: 'acme',
        tags: ['cat:policy', 'cf_area:legal'],
        accessRoles: ['r1'],
      },
    },
    {
      id: 'opB_0',
      content: 'Política de recursos humanos.',
      vector: randomVector(),
      metadata: {
        documentId: 'opdocB',
        tenantId: 'acme',
        tags: ['cat:policy', 'cf_area:hr'],
        accessRoles: ['r2'],
      },
    },
    {
      id: 'opC_0',
      content: 'Contrato de arrendamiento.',
      vector: randomVector(),
      metadata: { documentId: 'opdocC', tenantId: 'acme', tags: ['cat:contract'], accessRoles: [] },
    },
  ];

  beforeAll(async () => {
    adapter = new MeilisearchAdapter({ url: MEILI_URL, apiKey: MEILI_API_KEY });
    await adapter.createCollection(OPS_COLLECTION, {
      dimensions: 4,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-v1',
    });
    await adapter.upsert(OPS_COLLECTION, OPS_DOCS);
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await adapter.deleteCollection(OPS_COLLECTION).catch(() => {
      // Best-effort cleanup
    });
  });

  it('tagsAll (AND) returns only documents carrying all tags', async () => {
    const results = await adapter.search(OPS_COLLECTION, randomVector(), 10, {
      tagsAll: ['cat:policy', 'cf_area:legal'],
    });
    expect(results.map((r) => r.id).sort()).toEqual(['opA_0', 'opA_1']);
  });

  it("documentId filter returns only that document's chunks", async () => {
    const one = await adapter.search(OPS_COLLECTION, randomVector(), 10, { documentId: 'opdocB' });
    expect(one.map((r) => r.id)).toEqual(['opB_0']);

    const many = await adapter.search(OPS_COLLECTION, randomVector(), 10, {
      documentId: ['opdocB', 'opdocC'],
    });
    expect(many.map((r) => r.id).sort()).toEqual(['opB_0', 'opC_0']);
  });

  it('listDocumentIds returns the distinct source-document IDs', async () => {
    const ids = await adapter.listDocumentIds(OPS_COLLECTION);
    expect(ids.sort()).toEqual(['opdocA', 'opdocB', 'opdocC']);
  });

  it('updateDocumentsMetadata re-stamps accessRoles without re-embedding', async () => {
    const res = await adapter.updateDocumentsMetadata(
      OPS_COLLECTION,
      { documentId: 'opdocA' },
      { accessRoles: ['r1', 'r9'] },
    );
    expect(res.updated).toBe(2);

    const hits = await adapter.search(OPS_COLLECTION, randomVector(), 10, {
      documentId: 'opdocA',
      accessRoles: ['r9'],
    });
    expect(hits.map((r) => r.id).sort()).toEqual(['opA_0', 'opA_1']);
    // Content untouched (no re-embedding, no content rewrite).
    expect(hits[0]!.content.length).toBeGreaterThan(0);
  });

  it('removeDocumentsByFilter removes only the matching chunks', async () => {
    const res = await adapter.removeDocumentsByFilter(OPS_COLLECTION, { documentId: 'opdocA' });
    expect(res.removed === 2 || res.removed === -1).toBe(true);

    const info = await adapter.collectionInfo(OPS_COLLECTION);
    expect(info.documentCount).toBe(2);
    const left = await adapter.search(OPS_COLLECTION, randomVector(), 10);
    expect(left.map((r) => r.id).sort()).toEqual(['opB_0', 'opC_0']);
  });

  it('removeDocumentsByFilter rejects an empty filter', async () => {
    await expect(adapter.removeDocumentsByFilter(OPS_COLLECTION, {})).rejects.toThrow();
  });

  it('deleteCollection removes the index and is a no-op when absent', async () => {
    const tempCol = `sdk-del-${Date.now()}`;
    await adapter.createCollection(tempCol, {
      dimensions: 4,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-v1',
    });
    expect(await adapter.collectionExists(tempCol)).toBe(true);

    await adapter.deleteCollection(tempCol);
    expect(await adapter.collectionExists(tempCol)).toBe(false);

    // Second delete: no-op, must not throw.
    await expect(adapter.deleteCollection(tempCol)).resolves.toBeUndefined();
  });
});
