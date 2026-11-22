/**
 * Document structure: articles and sections, structure-aware chunking,
 * article-scoped relations, articles repealed in the text, internal
 * references and the section in the source line.
 */
import { describe, it, expect } from 'vitest';

import { StructureParser } from '../../../src/rag/structure/StructureParser.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { DocumentLoaderRegistry } from '../../../src/rag/ingestion/DocumentLoaderRegistry.js';
import { PlainTextLoader } from '../../../src/rag/ingestion/loaders/PlainTextLoader.js';
import { RecursiveChunker } from '../../../src/rag/ingestion/chunking/RecursiveChunker.js';
import { IngestionPipeline } from '../../../src/rag/ingestion/IngestionPipeline.js';
import { RAGPipeline, notesFor, passageInactiveReason } from '../../../src/rag/RAGPipeline.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import type { EmbeddingResult, Passage, RerankResult } from '../../../src/rag/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

const DOC = [
  'ÍNDICE',
  '1.1. ALCANCE ................................ 3',
  '2.1 Procedimiento 4',
  '',
  'Artículo 1 (ALCANCE). Esta norma se aplica a todas las sucursales y a las agencias habilitadas.',
  'Circular 1234 de 15/03/2021',
  'Antecedentes: Circular 1.660 de 9 de setiembre de 1999',
  'Artículo 2 (DEROGADO).',
  'Artículo 3* (PLAZOS) Los reclamos se presentan dentro de los treinta días. Ver punto 2.1 para el procedimiento.',
  'Artículo 3 BIS (EXCEPCIONES). Se exceptúan los reclamos de montos menores.',
  'El texto cita el Artículo 302 del Código Penal y el artículo 8 del Decreto 120/15 sin ser encabezados.',
  '2.1 Procedimiento',
  'El reclamo se presenta por escrito ante la gerencia, con copia del comprobante.',
  'IV. DISPOSICIONES FINALES',
  'XXXVI - Insumos para el equipamiento.',
].join('\n');

describe('StructureParser', () => {
  const p = new StructureParser();

  it('finds articles, sections and chapters; ignores citations, the table of contents and list items', () => {
    const s = p.parse(DOC);
    expect(s.map((x) => `${x.kind}:${x.id}`)).toEqual([
      'article:1',
      'article:2',
      'article:3',
      'article:3 bis',
      'section:2.1',
      'section:IV',
    ]);
    expect(s.find((x) => x.id === '2')?.derogated).toBe(true);
    expect(s.find((x) => x.id === '1')?.amendedBy).toBe('Circular 1234 de 15/03/2021');
    expect(s.find((x) => x.id === '3')?.label).toMatch(/^Artículo 3\* \(PLAZOS\)/);
  });

  it('takes the wording from the heading too', () => {
    expect(
      p.parse('Artículo 5 (Redacción dada por la Ley 18.331 de 2008). Texto.')[0]?.amendedBy,
    ).toBe('la Ley 18.331 de 2008');
  });

  it('cover: the unit a range starts in and those that begin inside it', () => {
    const s = p.parse(DOC);
    const a2 = DOC.indexOf('Artículo 2');
    const inside = DOC.indexOf('Los reclamos');
    expect(p.cover(s, a2, inside)).toEqual({
      articles: ['2', '3'],
      label: 'Artículo 2 (DEROGADO).',
      derogated: ['2'],
      prevArticle: '1',
      nextArticle: '3 bis',
    });
    expect(p.cover(s, inside, inside + 10).articles).toEqual(['3']);
  });

  it('finds internal references, not those that name another document', () => {
    expect(
      p.internalReferences(
        'Ver punto 2.1 y, según el artículo 8, lo previsto; conforme al artículo 8 del Decreto 120/15; ver punto 4.',
      ),
    ).toEqual([
      { unit: 'section', id: '2.1', label: 'Ver punto 2.1' },
      { unit: 'article', id: '8', label: 'según el artículo 8' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

class OneVector extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/m';
  async embed(): Promise<EmbeddingResult> {
    return { vector: [1, 0, 0], model: 'm', dimensions: 3, tokensUsed: 0, latencyMs: 0 };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map(() => this.embed()));
  }
  getDimensions(): number {
    return 3;
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

async function ingest(mode: 'label' | 'split') {
  const loaders = new DocumentLoaderRegistry();
  loaders.register(new PlainTextLoader());
  const embedding = new EmbeddingRouter(new Map([['mock', new OneVector()]]));
  const store = new InMemoryVectorStore();
  const pipeline = new IngestionPipeline(
    loaders,
    new RecursiveChunker(),
    embedding,
    store,
    new EventBus(),
    new TokenTracker(new InMemoryAdapter()),
    { defaultEmbeddingProvider: 'mock', structure: { mode: 'off' } },
  );
  await pipeline.ingest({ type: 'text', text: DOC, metadata: { documentId: 'norma' } }, 'docs', {
    structure: mode,
    chunking: { chunkSize: 40, chunkOverlap: 0, minChunkSize: 10 },
  });
  return (await store.search('docs', [1, 0, 0], 100)).sort(
    (a, b) => (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0),
  );
}

describe('IngestionPipeline — structure', () => {
  it("'split' never mixes two articles in a chunk, and tags each chunk with its units", async () => {
    const chunks = await ingest('split');
    const sections = chunks.map(
      (c) => c.metadata.custom?.['section'] as { articles?: string[] } | undefined,
    );
    for (const s of sections) expect((s?.articles ?? []).length).toBeLessThanOrEqual(2);
    // The repealed article (heading only) joins the next unit instead of standing alone.
    const withTwo = chunks.find((c) => (c.metadata.tags ?? []).includes('art:2'));
    expect(withTwo?.metadata.custom?.['section']).toMatchObject({
      articles: ['2', '3'],
      derogated: ['2'],
    });
    const sec = chunks.find((c) => c.content.includes('ante la gerencia'));
    expect(sec?.metadata.tags).toContain('sec:2.1');
    const a1 = chunks.find((c) => c.content.includes('Esta norma'));
    expect(a1?.metadata.custom?.['section']).toMatchObject({
      articles: ['1'],
      amended: [{ article: '1', by: 'Circular 1234 de 15/03/2021' }],
    });
  });

  it("'label' keeps the chunking and records what each chunk covers", async () => {
    const chunks = await ingest('label');
    expect(chunks.some((c) => (c.metadata.tags ?? []).some((t) => t.startsWith('art:')))).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

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

const section = (articles: string[], extra: Record<string, unknown> = {}) => ({
  articles,
  label: `Artículo ${articles[0]}`,
  ...extra,
});

describe('RAGPipeline — structure', () => {
  async function setup(validity: { inactive?: 'flag' | 'exclude' } = {}) {
    const store = new InMemoryVectorStore();
    await store.createCollection('docs', {
      dimensions: 3,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock/m',
    });
    const chunk = (
      id: string,
      content: string,
      sec: Record<string, unknown>,
      tags: string[] = [],
    ) => ({
      id,
      content,
      vector: [1, 0, 0],
      metadata: {
        documentId: 'norma',
        title: 'Norma',
        chunkIndex: Number(id.slice(1)),
        tenantId: 't',
        accessRoles: ['r'],
        tags: ['cat:a', ...tags],
        custom: { section: sec },
      },
    });
    await store.upsert('docs', [
      chunk('c1', 'Los reclamos se presentan en treinta días. Ver punto 2.1.', section(['3']), [
        'art:3',
      ]),
      chunk('c2', 'Artículo 70 (DEROGADO).', section(['70'], { derogated: ['70'] }), ['art:70']),
      chunk(
        'c3',
        'El reclamo se presenta por escrito ante la gerencia.',
        { sections: ['2.1'], label: '2.1 Procedimiento' },
        ['sec:2.1'],
      ),
      chunk(
        'c4',
        'Artículo 5. Horario de atención.',
        section(['5'], { amended: [{ article: '5', by: 'Circular 1234' }] }),
        ['art:5'],
      ),
    ]);
    const embedding = new EmbeddingRouter();
    embedding.registerProvider(new OneVector());
    const pipeline = new RAGPipeline(
      embedding,
      store,
      new TableReranker({ c1: 0.9, c2: 0.8, c3: 0.6, c4: 0.7 }),
      new EventBus(),
      new TokenTracker(),
      undefined,
      'require',
      {
        references: { mode: 'follow', structure: new StructureParser() },
        validity: { mode: 'on', ...validity },
      },
    );
    return pipeline;
  }
  const run = (pipeline: RAGPipeline, extra: Record<string, unknown> = {}) =>
    pipeline.search(
      {
        query: 'reclamos',
        collections: ['docs'],
        topK: 10,
        finalTopK: 2,
        minScore: 0.5,
        searchMode: 'vector',
        filters: { tenantId: 't', accessRoles: ['r'] },
        resolveReferences: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, []])),
        ...extra,
      } as never,
      CONTEXT,
    );

  it('follows an internal reference to the section it names', async () => {
    const result = await run(await setup());
    expect(result.passages.map((p) => p.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.trace.references?.internal).toEqual([
      {
        key: 'sec:2.1',
        label: 'Ver punto 2.1',
        fromPassageId: 'c1',
        documentId: 'norma',
        found: true,
        added: [{ id: 'c3', documentId: 'norma', chunkIndex: 3, score: 0.6 }],
      },
    ]);
  });

  it('notes an article repealed in the text, and excludes it under inactive: exclude', async () => {
    let result = await run(await setup());
    expect(result.passages.find((p) => p.id === 'c2')?.notes).toEqual([
      {
        kind: 'article_derogated',
        articles: ['70'],
        text: 'Article 70 is marked as repealed in the document.',
      },
    ]);
    result = await run(await setup({ inactive: 'exclude' }));
    expect(result.passages.map((p) => p.id)).not.toContain('c2');
    expect(result.trace.status?.excluded).toEqual([
      { id: 'c2', documentId: 'norma', reason: 'derogated' },
    ]);
  });

  it('a relation that names articles applies only to the passages of those articles', async () => {
    const describeDocuments = async () => ({
      norma: {
        incoming: [
          {
            type: 'modifies' as const,
            fromDocumentId: 'otra',
            fromLabel: 'Resolución 9/21',
            articles: ['5'],
            status: 'confirmed' as const,
          },
        ],
      },
    });
    const result = await run(await setup(), { describeDocuments, finalTopK: 4, relations: 'off' });
    const kinds = (id: string) =>
      (result.passages.find((p) => p.id === id)?.notes ?? []).map((n) => n.kind);
    expect(kinds('c4')).toEqual(['modified']);
    expect(kinds('c1')).toEqual([]);
  });

  it('a relation that names articles is followed only from a passage of those articles', async () => {
    const describeDocuments = async () => ({
      norma: {
        incoming: [
          {
            type: 'modifies' as const,
            fromDocumentId: 'otra',
            fromLabel: 'Resolución 9/21',
            articles: ['5'],
            status: 'confirmed' as const,
          },
        ],
      },
    });
    // Context: articles 3 and 70 only (finalTopK 2) → the amending document is not searched.
    const result = await run(await setup(), { describeDocuments, relations: 'on' });
    expect(result.trace.status?.followed).toEqual([]);
  });

  it('the source line names the article and its wording', async () => {
    const pipeline = await setup();
    const c4: Passage = {
      id: 'c4',
      content: 'Horario.',
      score: 1,
      collection: 'docs',
      metadata: {
        documentId: 'norma',
        title: 'Norma',
        custom: { section: section(['5'], { amended: [{ article: '5', by: 'Circular 1234' }] }) },
      },
    };
    expect(pipeline.formatForContext([c4])).toBe(
      'Horario.\nSource: Norma — Artículo 5 [Circular 1234]',
    );
    expect(pipeline.formatForContext([c4], { includeSection: false })).toBe(
      'Horario.\nSource: Norma',
    );
  });

  it('passageInactiveReason and notesFor with partial repeals by article', () => {
    const status = {
      incoming: [
        {
          type: 'derogates' as const,
          fromDocumentId: 'x',
          scope: 'partial' as const,
          articles: ['4'],
          status: 'confirmed' as const,
        },
      ],
    };
    expect(passageInactiveReason(status, { articles: ['4'] })).toBe('derogated');
    expect(passageInactiveReason(status, { articles: ['4', '5'] })).toBeUndefined();
    expect(passageInactiveReason(status, undefined)).toBeUndefined();
    expect(notesFor(status, true, Date.now(), { articles: ['5'] })).toEqual([]);
    expect(notesFor(status, true, Date.now(), { articles: ['4'] }).map((n) => n.kind)).toEqual([
      'partially_derogated',
    ]);
  });
});
