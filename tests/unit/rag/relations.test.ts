/**
 * Relations between documents (repeals, amendments, regulations) and
 * document validity: extraction, ingestion tags, the pipeline stage, the
 * notes in the context and the guidance for the synthesis.
 */
import { describe, it, expect, vi } from 'vitest';

import { ReferenceExtractor } from '../../../src/rag/references/ReferenceExtractor.js';
import { RelationExtractor } from '../../../src/rag/references/RelationExtractor.js';
import { documentTags } from '../../../src/rag/references/documentTags.js';
import { LegalProfile } from '../../../src/rag/legal/LegalProfile.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline, buildContextGuidance, inactiveReason } from '../../../src/rag/RAGPipeline.js';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import type { EmbeddingResult, Passage, RerankResult } from '../../../src/rag/types.js';
import type {
  DocumentStatus,
  ExecutionContext,
  RAGPipelineValidityOptions,
} from '../../../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// RelationExtractor
// ─────────────────────────────────────────────────────────────────────────────

describe('RelationExtractor', () => {
  const x = new RelationExtractor();
  const one = (text: string) => x.extract(text);

  it('finds total and partial repeals, amendments and regulations', () => {
    expect(one('Artículo 1°.- Derógase el Decreto N° 732/019.')).toEqual([
      expect.objectContaining({
        type: 'derogates',
        target: 'decree:732/2019',
        scope: 'total',
        strength: 'explicit',
      }),
    ]);
    expect(one('Derógase el artículo 3 de la Ley N° 18.331.')).toEqual([
      expect.objectContaining({
        type: 'derogates',
        target: 'law:18331',
        scope: 'partial',
        articles: ['3'],
      }),
    ]);
    expect(
      one('Art. 2. Modifícase el artículo 5 del Decreto 654/018, que quedará redactado así:'),
    ).toEqual([
      expect.objectContaining({
        type: 'modifies',
        target: 'decree:654/2018',
        scope: 'partial',
        articles: ['5'],
        strength: 'explicit',
      }),
    ]);
    expect(one('Reglaméntase la Ley N° 19.210, de inclusión financiera.')).toEqual([
      expect.objectContaining({ type: 'regulates', target: 'law:19210' }),
    ]);
  });

  it('handles the passive voice, English and Portuguese', () => {
    expect(one('El Decreto 732/019 queda derogado.')[0]).toMatchObject({
      type: 'derogates',
      target: 'decree:732/2019',
      strength: 'explicit',
    });
    expect(one('Law 123 is hereby repealed.')[0]).toMatchObject({
      type: 'derogates',
      target: 'law:123',
    });
    expect(one('Fica revogada a Lei 8.078.')[0]).toMatchObject({
      type: 'derogates',
      target: 'law:8078',
    });
  });

  it('ignores narratives in the past and citations without an operative verb', () => {
    expect(one('El Decreto 100/015 derogó la Ley 123 en su momento.')).toEqual([]);
    expect(one('VISTO: lo dispuesto por el Decreto 732/019 y la Ley 18.331.')).toEqual([]);
  });

  it('marks as inferred a statement that names several documents', () => {
    const rels = one('Deróganse el Decreto 1/020 y el Decreto 2/020.');
    expect(rels.map((r) => [r.target, r.strength])).toEqual([
      ['decree:1/2020', 'inferred'],
      ['decree:2/2020', 'inferred'],
    ]);
  });

  it('accepts custom verbs', () => {
    const custom = new RelationExtractor({
      profile: new LegalProfile({
        packs: [],
        references: [{ kind: 'law', words: ['law'] }],
        relations: [{ type: 'derogates', words: ['wird aufgehoben'] }],
      }),
    });
    expect(custom.extract('Das Law 55 wird aufgehoben.')[0]).toMatchObject({
      type: 'derogates',
      target: 'law:55',
    });
  });

  it('builds the ingestion tags: identity and stated relations, never itself', () => {
    expect(
      documentTags(
        new ReferenceExtractor(),
        x,
        'Decreto 1203/020',
        'Derógase el Decreto N° 732/019. Modifícase el artículo 2 del Decreto 1203/020.',
      ),
    ).toEqual(['ref:decree:1203/2020', 'rel:derogates:decree:732/2019']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

class OneVector extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/m';
  async embed(): Promise<EmbeddingResult> {
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

const SCORES = { 'old-1': 0.9, 'new-1': 0.7, 'other-1': 0.6, 'low-1': 0.65 };

async function setup(
  validity: RAGPipelineValidityOptions = {},
  extra: { tags?: Record<string, string[]>; custom?: Record<string, Record<string, unknown>> } = {},
) {
  const store = new InMemoryVectorStore();
  await store.createCollection('docs', {
    dimensions: 3,
    distanceMetric: 'cosine',
    embeddingProvider: 'mock',
    embeddingModel: 'mock/m',
  });
  const doc = (id: string, documentId: string, title: string, content: string, cat: string) => ({
    id,
    content,
    vector: [1, 0, 0],
    metadata: {
      documentId,
      title,
      chunkIndex: 0,
      tenantId: 't',
      accessRoles: ['r'],
      tags: [cat, ...(extra.tags?.[documentId] ?? [])],
      ...(extra.custom?.[documentId] !== undefined && { custom: extra.custom[documentId] }),
    },
  });
  await store.upsert('docs', [
    doc('old-1', 'dec732', 'Decreto 732/019', 'Los registros se conservan 5 años.', 'cat:a'),
    doc(
      'new-1',
      'dec1203',
      'Decreto 1203/020',
      'Derógase el Decreto 732/019. Los registros se conservan 10 años.',
      'cat:b',
    ),
    doc('other-1', 'manual', 'Manual', 'Archivar los registros a diario.', 'cat:a'),
  ]);
  const embedding = new EmbeddingRouter();
  embedding.registerProvider(new OneVector());
  const bus = new EventBus();
  const pipeline = new RAGPipeline(
    embedding,
    store,
    new TableReranker(SCORES),
    bus,
    new TokenTracker(),
    undefined,
    'require',
    { relations: { mode: 'on' }, validity: { mode: 'on', ...validity } },
  );
  return { pipeline, store, bus };
}

const search = (pipeline: RAGPipeline, extra: Record<string, unknown> = {}) =>
  pipeline.search(
    {
      query: '¿cuánto tiempo se conservan los registros?',
      collections: ['docs'],
      topK: 10,
      finalTopK: 2,
      minScore: 0.5,
      searchMode: 'vector',
      filters: { tenantId: 't', accessRoles: ['r'], tagsAll: ['cat:a'] },
      ...extra,
    } as never,
    CONTEXT,
  );

const repealed = (status: 'confirmed' | 'proposed'): Record<string, DocumentStatus> => ({
  dec732: {
    incoming: [
      {
        type: 'derogates',
        fromDocumentId: 'dec1203',
        fromLabel: 'Decreto 1203/020',
        status,
        date: '2020-05-04',
      },
    ],
  },
});

describe('RAGPipeline — relations and validity', () => {
  it('brings the repealing document and notes both sides', async () => {
    const { pipeline } = await setup();
    const describeDocuments = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, repealed('confirmed')[id] ?? {}])),
    );
    const result = await search(pipeline, { describeDocuments });
    expect(result.passages.map((p) => p.id)).toEqual(['old-1', 'other-1', 'new-1']);
    const old = result.passages[0]!;
    expect(old.notes).toEqual([
      expect.objectContaining({
        kind: 'derogated',
        status: 'confirmed',
        documentId: 'dec1203',
        text: 'Repealed by Decreto 1203/020 on 2020-05-04.',
      }),
    ]);
    expect(result.passages[2]!.notes?.[0]).toMatchObject({
      kind: 'relation_source',
      relation: 'derogates',
      text: 'This document repeals Decreto 732/019.',
    });
    expect(result.trace.status).toEqual({
      notes: [
        { documentId: 'dec732', kinds: ['derogated'] },
        { documentId: 'dec1203', kinds: ['relation_source'] },
      ],
      excluded: [],
      followed: [
        {
          type: 'derogates',
          status: 'confirmed',
          fromDocumentId: 'dec1203',
          toDocumentId: 'dec732',
          added: [{ id: 'new-1', documentId: 'dec1203', chunkIndex: 0, score: 0.7 }],
        },
      ],
    });
    expect(result.metrics.statusLatencyMs).toBeTypeOf('number');
  });

  it('excludes a confirmed repeal under inactive: exclude, and still brings its replacement', async () => {
    const { pipeline } = await setup({ inactive: 'exclude' });
    const describeDocuments = async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, repealed('confirmed')[id] ?? {}]));
    const result = await search(pipeline, { describeDocuments });
    expect(result.passages.map((p) => p.id)).toEqual(['other-1', 'new-1']);
    expect(result.trace.status?.excluded).toEqual([
      { id: 'old-1', documentId: 'dec732', reason: 'derogated' },
    ]);
    expect(result.trace.candidates.map((c) => c.id)).not.toContain('old-1');
  });

  it('never excludes on a proposed relation: it only warns', async () => {
    const { pipeline } = await setup({ inactive: 'exclude' });
    const describeDocuments = async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, repealed('proposed')[id] ?? {}]));
    const result = await search(pipeline, { describeDocuments });
    expect(result.passages[0]!.id).toBe('old-1');
    expect(result.passages[0]!.notes?.[0]?.text).toBe(
      'Possibly repealed by Decreto 1203/020 (unconfirmed; verify).',
    );
  });

  it('flags expired and future documents, shows the version and weighs priority', async () => {
    const { pipeline } = await setup({ priorityWeight: 0.4 });
    const describeDocuments = async () => ({
      dec732: { validTo: '2001-01-01', version: '3' },
      manual: { priority: 'high' as const, validFrom: '2999-01-01' },
    });
    const result = await search(pipeline, { describeDocuments, relations: 'off' });
    expect(result.passages.map((p) => p.id)).toEqual(['other-1', 'old-1']);
    expect(result.passages[1]!.notes?.map((n) => n.kind)).toEqual(['expired', 'version']);
    expect(result.passages[0]!.notes?.map((n) => n.text)).toEqual(['In force from 2999-01-01.']);
    expect(result.trace.status?.followed).toEqual([]);
  });

  it('works from the index alone: validity metadata and relation tags', async () => {
    const { pipeline } = await setup(
      {},
      {
        tags: { dec732: ['ref:decree:732/2019'], dec1203: ['rel:derogates:decree:732/2019'] },
        custom: { manual: { validTo: '2001-01-01' } },
      },
    );
    const result = await search(pipeline);
    expect(result.passages.map((p) => p.id)).toEqual(['old-1', 'other-1', 'new-1']);
    expect(result.passages[0]!.notes?.[0]).toMatchObject({
      kind: 'derogated',
      status: 'proposed',
      text: 'Possibly repealed by Decreto 1203/020 (unconfirmed; verify).',
    });
    expect(result.passages[1]!.notes?.[0]?.kind).toBe('expired');
  });

  it('does nothing when both are off', async () => {
    const { pipeline } = await setup();
    const describeDocuments = vi.fn(async () => repealed('confirmed'));
    const result = await search(pipeline, {
      describeDocuments,
      relations: 'off',
      validity: 'off',
    });
    expect(describeDocuments).not.toHaveBeenCalled();
    expect(result.trace.status).toBeUndefined();
    expect(result.passages.every((p) => p.notes === undefined)).toBe(true);
  });

  it('inactiveReason: expired by date, repealed only when confirmed and total', () => {
    const now = Date.parse('2026-01-01');
    expect(inactiveReason({ validTo: '2025-12-31' }, now)).toBe('expired');
    expect(inactiveReason({ validTo: '2026-01-01' }, now)).toBeUndefined();
    const rel = { type: 'derogates' as const, fromDocumentId: 'x', status: 'confirmed' as const };
    expect(inactiveReason({ incoming: [rel] }, now)).toBe('derogated');
    expect(inactiveReason({ incoming: [{ ...rel, scope: 'partial' }] }, now)).toBeUndefined();
    expect(inactiveReason({ incoming: [{ ...rel, status: 'proposed' }] }, now)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Context and guidance
// ─────────────────────────────────────────────────────────────────────────────

describe('Context notes and guidance', () => {
  const passage = (notes?: Passage['notes']): Passage => ({
    id: 'p',
    content: 'Texto.',
    score: 1,
    collection: 'docs',
    metadata: { documentId: 'd', title: 'Doc' },
    ...(notes !== undefined && { notes }),
  });
  const note = {
    kind: 'expired' as const,
    date: '2001-01-01',
    text: 'No longer in force since 2001-01-01.',
  };

  it('formatForContext adds the status line, with the host rendering if given', async () => {
    const { pipeline } = await setup();
    expect(pipeline.formatForContext([passage([note])])).toBe(
      'Texto.\nSource: Doc\nStatus: No longer in force since 2001-01-01.',
    );
    expect(
      pipeline.formatForContext([passage([note])], {
        notesLabel: 'Estado',
        noteText: (n) => `vencido el ${n.date}`,
      }),
    ).toBe('Texto.\nSource: Doc\nEstado: vencido el 2001-01-01');
    expect(pipeline.formatForContext([passage([note])], { includeNotes: false })).toBe(
      'Texto.\nSource: Doc',
    );
  });

  it('buildContextGuidance lists missing documents and explains the notes', () => {
    const trace = {
      references: {
        followed: [],
        missing: [
          { key: 'annex:33', label: 'Anexo XXXIII', fromPassageId: 'p', fromDocumentId: 'd' },
        ],
      },
    } as never;
    expect(buildContextGuidance({ passages: [passage()], trace: {} as never })).toBe('');
    const g = buildContextGuidance({ passages: [passage([note])], trace });
    expect(g).toContain('not available: Anexo XXXIII.');
    expect(g).toContain('Do not present repealed or expired content as current');
    expect(
      buildContextGuidance({ passages: [passage()], trace }, { missingHeading: 'Faltan:' }),
    ).toMatch(/^Faltan: Anexo XXXIII\./);
  });

  it('the RAG tool passes the status options and appends the guidance', async () => {
    const searchFn = vi.fn(async () => ({
      passages: [passage([note])],
      totalFound: 1,
      trace: {},
      metrics: { totalLatencyMs: 1 },
    }));
    const describeDocuments = vi.fn();
    const tool = createRAGTool(
      {
        search: searchFn,
        formatForContext: () => 'CTX',
      } as unknown as RAGPipeline,
      ['docs'],
      {},
      { status: () => ({ describeDocuments, validity: 'on' }) },
    );
    const out = await tool.execute({ query: 'x' }, CONTEXT);
    expect(searchFn.mock.calls[0]![0]).toMatchObject({ describeDocuments, validity: 'on' });
    expect((out.data as { context: string }).context).toMatch(/^CTX\n\nSome passages carry/);
  });
});
