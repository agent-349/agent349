/**
 * Cross-document references: extraction and normalisation, document identity,
 * and the pipeline stage that follows the references of the context passages.
 */
import { describe, it, expect, vi } from 'vitest';

import { ReferenceExtractor } from '../../../src/rag/references/ReferenceExtractor.js';
import { LegalProfile } from '../../../src/rag/legal/LegalProfile.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import type { EmbeddingResult, Passage, RerankResult } from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

describe('ReferenceExtractor', () => {
  const x = new ReferenceExtractor();

  it('normalises annexes, laws, decrees, circulars and resolutions', () => {
    const refs = x.extract(
      'Conforme al Anexo XIV y al anexo 14, la Ley N° 12.345, el Decreto 120/015, la Circular Nº 3.456 y la Resolución 45-2020.',
    );
    expect(refs.map((r) => r.key)).toEqual([
      'annex:14',
      'law:12345',
      'decree:120/2015',
      'circular:3456',
      'resolution:45/2020',
    ]);
    expect(refs[0]).toEqual({ key: 'annex:14', label: 'Anexo XIV', count: 2 });
  });

  it('handles English and Portuguese, and rejects invalid Roman numerals', () => {
    expect(
      x.extract('See Annex IV and Law 123; ver Lei 8.078 e Decreto-Lei 41/2019').map((r) => r.key),
    ).toEqual(['annex:4', 'law:123', 'law:8078', 'decree:41/2019']);
    expect(x.extract('Anexo IIII y anexo Informativo')).toEqual([]);
  });

  it('identifies a document from its title', () => {
    expect(x.identify('2 - ANEXO II - Decreto 120-15.pdf')).toEqual(['annex:2', 'decree:120/2015']);
    expect(x.identify('14 A - ANEXO XIV - Envío de Documentación.pdf')).toEqual(['annex:14']);
    expect(x.identify('Reglamento Interno 2025.pdf')).toEqual([]);
    expect(x.identify('30 - ANEXO - Formularios.pdf')).toEqual([]);
    expect(
      new ReferenceExtractor({ profile: new LegalProfile({ numberedTitles: true }) }).identify('30 - ANEXO - Formularios.pdf'),
    ).toEqual(['annex:30']);
    expect(x.identify('Reglamento.pdf', 'ANEXO XXX - Formularios ...')).toEqual(['annex:30']);
  });

  it('accepts custom patterns and can drop the built-in ones', () => {
    const custom = new ReferenceExtractor({
      profile: new LegalProfile({
        packs: [],
        references: [{ kind: 'policy', pattern: '\\bPolicy\\s+([A-Z]{2}-\\d+)' }],
      }),
    });
    expect(custom.extract('Under Policy HR-12 and Annex IV').map((r) => r.key)).toEqual([
      'policy:hr-12',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

class OneVector extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/m';
  calls = 0;
  async embed(): Promise<EmbeddingResult> {
    this.calls++;
    return { vector: [1, 0, 0], model: 'm', dimensions: 3, tokensUsed: 0, latencyMs: 0 };
  }
  async embedBatch(): Promise<EmbeddingResult[]> {
    return [];
  }
  getDimensions(): number {
    return 3;
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

class TableReranker extends RerankerProvider {
  readonly name = 'table';
  constructor(private readonly scores: Record<string, number>) {
    super();
  }
  async rerank(_q: string, passages: Passage[], topK: number): Promise<RerankResult> {
    return {
      passages: passages
        .map((p) => ({ ...p, score: this.scores[p.id] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK),
      model: 't',
      latencyMs: 0,
    };
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

const CONTEXT: ExecutionContext = {
  tenantId: 't',
  userId: 'u',
  roles: ['r'],
  sessionId: 's',
  agentId: 'a',
  requestId: 'q',
};

async function setup(scores: Record<string, number>, refs: { maxTargets?: number } = {}) {
  const store = new InMemoryVectorStore();
  await store.createCollection('docs', {
    dimensions: 3,
    distanceMetric: 'cosine',
    embeddingProvider: 'mock',
    embeddingModel: 'mock/m',
  });
  const doc = (id: string, documentId: string, content: string, tags: string[]) => ({
    id,
    content,
    vector: [1, 0, 0],
    metadata: {
      documentId,
      chunkIndex: Number(id.split('-')[1]) - 1,
      tenantId: 't',
      accessRoles: ['r'],
      tags,
    },
  });
  await store.upsert('docs', [
    doc('reg-1', 'reglamento', 'La documentación se envía según el Anexo XIV y el Anexo XXXIII.', [
      'cat:reglamento',
    ]),
    doc('anx14-1', 'anexo14', 'Anexo XIV: los sobres se envían por valija los martes.', [
      'cat:anexos',
    ]),
    doc('anx14-2', 'anexo14', 'Anexo XIV: formulario de remito.', ['cat:anexos']),
    doc('secret-1', 'secreto', 'Anexo XIV confidencial', ['cat:anexos']),
  ]);
  // The confidential document is not visible to role 'r'.
  await store.updateDocumentsMetadata(
    'docs',
    { documentId: 'secreto' },
    { accessRoles: ['admin'] },
  );
  const embedding = new EmbeddingRouter();
  const provider = new OneVector();
  embedding.registerProvider(provider);
  const bus = new EventBus();
  const pipeline = new RAGPipeline(
    embedding,
    store,
    new TableReranker(scores),
    bus,
    new TokenTracker(),
    undefined,
    'require',
    {
      references: { mode: 'follow', extractor: new ReferenceExtractor(), ...refs },
    },
  );
  const resolve = vi.fn(async (keys: string[]) => {
    const map: Record<string, string[]> = { 'annex:14': ['anexo14', 'secreto'] };
    return Object.fromEntries(keys.map((k) => [k, map[k] ?? []]));
  });
  stores.set(pipeline, store);
  return { pipeline, resolve, provider, bus };
}

const stores = new WeakMap<RAGPipeline, InMemoryVectorStore>();
const storeOf = (pipeline: RAGPipeline): InMemoryVectorStore => stores.get(pipeline)!;

const search = (pipeline: RAGPipeline, resolve: unknown, extra: Record<string, unknown> = {}) =>
  pipeline.search(
    {
      query: '¿cómo envío la documentación?',
      collections: ['docs'],
      topK: 1,
      finalTopK: 3,
      minScore: 0.5,
      searchMode: 'vector',
      filters: { tenantId: 't', accessRoles: ['r'], tagsAll: ['cat:reglamento'] },
      resolveReferences: resolve,
      ...extra,
    } as never,
    CONTEXT,
  );

describe('RAGPipeline — references', () => {
  it('adds relevant passages of the cited document, crossing the category scope but not the ACL', async () => {
    const { pipeline, resolve, provider } = await setup({
      'reg-1': 0.9,
      'anx14-1': 0.8,
      'anx14-2': 0.2,
      'secret-1': 1,
    });
    const result = await search(pipeline, resolve);
    expect(resolve).toHaveBeenCalledWith(['annex:14', 'annex:33']);
    expect(result.passages.map((p) => p.id)).toEqual(['reg-1', 'anx14-1']);
    expect(result.trace.references?.followed[0]).toMatchObject({
      key: 'annex:14',
      label: 'Anexo XIV',
      fromDocumentId: 'reglamento',
      added: [{ id: 'anx14-1', documentId: 'anexo14', chunkIndex: 0, score: 0.8 }],
    });
    expect(result.trace.references?.missing).toEqual([
      {
        key: 'annex:33',
        label: 'Anexo XXXIII',
        fromPassageId: 'reg-1',
        fromDocumentId: 'reglamento',
      },
    ]);
    expect(provider.calls).toBe(1); // the cited document is searched with the same query vector
  });

  it('does nothing when off or when the context is empty', async () => {
    const { pipeline, resolve } = await setup({ 'reg-1': 0.9, 'anx14-1': 0.8 });
    expect(
      (await search(pipeline, resolve, { references: 'off' })).trace.references,
    ).toBeUndefined();
    const empty = await setup({ 'reg-1': 0.1 });
    expect((await search(empty.pipeline, empty.resolve)).trace.references).toBeUndefined();
  });

  it('ignores self-references and documents already in the context', async () => {
    const { pipeline } = await setup({ 'reg-1': 0.9, 'anx14-1': 0.8 });
    const resolve = vi.fn(async () => ({ 'annex:14': ['reglamento'], 'annex:33': ['reglamento'] }));
    const result = await search(pipeline, resolve);
    expect(result.passages.map((p) => p.id)).toEqual(['reg-1']);
    expect(result.trace.references).toEqual({ followed: [], missing: [] });
  });

  it('caps the cited documents searched with maxTargets', async () => {
    const { pipeline } = await setup({ 'reg-1': 0.9, 'anx14-1': 0.8 }, { maxTargets: 1 });
    const resolve = vi.fn(async () => ({ 'annex:14': ['anexo14'], 'annex:33': ['otro'] }));
    const result = await search(pipeline, resolve);
    expect(result.trace.references?.followed.map((f) => f.targets)).toEqual([['anexo14']]);
  });

  it('without a host resolver, resolves through the identity tags written at ingestion', async () => {
    const { pipeline } = await setup({ 'reg-1': 0.9, 'anx14-1': 0.8, 'anx14-2': 0.2 });
    // No tags yet: everything cited is missing.
    let result = await search(pipeline, undefined);
    expect(result.trace.references?.missing.map((m) => m.key)).toEqual(['annex:14', 'annex:33']);
    // Tag the Anexo XIV as ingestion would.
    const store = storeOf(pipeline);
    await store.updateDocumentsMetadata(
      'docs',
      { documentId: 'anexo14' },
      {
        tags: ['cat:anexos', 'ref:annex:14'],
      },
    );
    result = await search(pipeline, undefined);
    expect(result.passages.map((p) => p.id)).toEqual(['reg-1', 'anx14-1']);
    expect(result.trace.references?.missing.map((m) => m.key)).toEqual(['annex:33']);
  });

  it('the RAG tool passes the host resolver', async () => {
    const searchFn = vi.fn(async () => ({ passages: [], totalFound: 0 }));
    const resolve = vi.fn();
    const tool = createRAGTool(
      { search: searchFn, formatForContext: () => '' } as unknown as RAGPipeline,
      ['docs'],
      {},
      {
        references: () => resolve,
      },
    );
    await tool.execute({ query: 'x' }, CONTEXT);
    expect(searchFn.mock.calls[0]![0]).toMatchObject({ resolveReferences: resolve });
  });
});
