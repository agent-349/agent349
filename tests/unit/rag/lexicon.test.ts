/**
 * Lexicon: stop words for the keyword component, glossary parsing, merging
 * and matching, and how the pipeline, rewriters, expander and RAG tool use
 * them. Offline.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  StopWords,
  parseGlossary,
  mergeGlossaries,
  matchGlossary,
  matchGlossaryTerms,
  formatGlossary,
} from '../../../src/rag/lexicon/Lexicon.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { QueryRewriter } from '../../../src/rag/queryRewriting/QueryRewriter.js';
import type { RewriteCallOptions } from '../../../src/rag/queryRewriting/QueryRewriter.js';
import { ContextualRewriter } from '../../../src/rag/queryRewriting/ContextualRewriter.js';
import { QueryExpander } from '../../../src/rag/queryRewriting/QueryExpander.js';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { EmbeddingResult } from '../../../src/rag/types.js';
import type {
  ExecutionContext,
  GlossaryEntry,
  LLMMessage,
  QueryRewriteOutcome,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// StopWords
// ─────────────────────────────────────────────────────────────────────────────

describe('StopWords', () => {
  it('removes function words and surrounding punctuation from the keyword text', () => {
    const sw = new StopWords({ stopWords: 'auto', languages: ['es'] });
    expect(sw.keywordQuery('¿Qué hago si me dan dólares falsos?')).toEqual({
      text: 'hago dan dólares falsos',
      removed: 3,
    });
  });

  it('never removes negations and exclusions, in any language', () => {
    const sw = new StopWords({ stopWords: 'auto' }); // every built-in language
    // "no" is a Portuguese stop word ("in the") and a Spanish negation.
    expect(sw.keywordQuery('¿no se puede pagar sin cédula ni solo con firma?').text).toBe(
      'no puede pagar sin cédula ni solo firma',
    );
    expect(sw.keywordQuery('can I pay without an ID').text).toBe('can pay without ID');
  });

  it('uses the languages of the search over the configured ones', () => {
    const sw = new StopWords({ stopWords: 'auto', languages: ['es'] });
    expect(sw.keywordQuery('the policy of the agency').text).toBe('the policy of the agency'); // no es stop words
    expect(sw.keywordQuery('the policy of the agency', ['en-US']).text).toBe('policy agency');
  });

  it('keeps inner symbols, matches regardless of accents, keeps the query when all are stop words', () => {
    const sw = new StopWords({ stopWords: 'auto', languages: ['es'] });
    expect(sw.keywordQuery('cuanto es en U$S').text).toBe('U$S');
    expect(sw.keywordQuery('¿qué es?')).toEqual({ text: '¿qué es?', removed: 0 });
  });

  it('supports a fixed list, extra and keep words, and off', () => {
    expect(new StopWords({ stopWords: ['agencia'] }).keywordQuery('la agencia abre').text).toBe(
      'la abre',
    );
    const tuned = new StopWords({
      stopWords: 'auto',
      languages: ['es'],
      extraStopWords: ['favor'],
      keepWords: ['como'],
    });
    expect(tuned.keywordQuery('por favor como pago').text).toBe('como pago');
    const off = new StopWords({ stopWords: false });
    expect(off.enabled).toBe(false);
    expect(off.keywordQuery('de la agencia')).toEqual({ text: 'de la agencia', removed: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Glossary
// ─────────────────────────────────────────────────────────────────────────────

describe('glossary', () => {
  const TEXT = [
    '# Glosario de la empresa',
    'ERP = Sistema de Planificación de Recursos',
    'U$S, USD = dólares estadounidenses',
    'dólar, dólares, U$S',
    'arqueo',
    'cobranza =',
    '',
  ].join('\n');

  it('parses meanings and equivalents, reporting unreadable lines', () => {
    const { entries, errors } = parseGlossary(TEXT);
    expect(entries).toEqual([
      { terms: ['ERP'], definition: 'Sistema de Planificación de Recursos' },
      { terms: ['U$S', 'USD'], definition: 'dólares estadounidenses' },
      { terms: ['dólar', 'dólares', 'U$S'] },
    ]);
    expect(errors.map((e) => e.line)).toEqual([5, 6]);
  });

  it('merges later glossaries over earlier ones by shared term', () => {
    const installation: GlossaryEntry[] = [
      { terms: ['ERP'], definition: 'old meaning' },
      { terms: ['BPS'], definition: 'Banco de Previsión Social' },
    ];
    const collection: GlossaryEntry[] = [
      { terms: ['erp'], definition: 'Sistema de Planificación de Recursos' },
    ];
    const merged = mergeGlossaries(installation, collection);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.terms[0] === 'erp')?.definition).toBe(
      'Sistema de Planificación de Recursos',
    );
  });

  it('matches whole terms regardless of case and accents', () => {
    const { entries } = parseGlossary(TEXT);
    expect(matchGlossary(entries, ['¿cómo entro al erp?']).map((e) => e.terms[0])).toEqual(['ERP']);
    expect(matchGlossary(entries, ['me pagaron en dolares'])).toEqual([entries[2]]);
    expect(matchGlossary(entries, ['saos y usdt'])).toEqual([]);
    expect(matchGlossary(entries, ['monto en U$S']).length).toBe(2);
    expect(matchGlossary(entries, ['ERP y USD'], 1)).toHaveLength(1);
  });

  it('reports the term that was found, not the first of the entry', () => {
    const { entries } = parseGlossary(TEXT);
    expect(matchGlossaryTerms(entries, ['me pagaron en dolares']).map((m) => m.term)).toEqual([
      'dólares',
    ]);
  });

  it('formats entries for prompts', () => {
    expect(formatGlossary(parseGlossary(TEXT).entries)).toBe(
      '- ERP: Sistema de Planificación de Recursos\n- U$S / USD: dólares estadounidenses\n- dólar = dólares = U$S (same thing)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

class FixedEmbedding extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/mock-v1';
  readonly texts: string[] = [];
  async embed(text: string): Promise<EmbeddingResult> {
    this.texts.push(text);
    return { vector: [1, 0, 0], model: 'mock-v1', dimensions: 3, tokensUsed: 0, latencyMs: 0 };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  getDimensions(): number {
    return 3;
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

class RecordingRewriter extends QueryRewriter {
  readonly name = 'recording';
  readonly calls: (RewriteCallOptions | undefined)[] = [];
  async rewrite(query: string): Promise<string> {
    return query;
  }
  override async rewriteWithOutcome(
    query: string,
    _history?: LLMMessage[],
    options?: RewriteCallOptions,
  ): Promise<QueryRewriteOutcome> {
    this.calls.push(options);
    return { query, applied: false };
  }
}

const CONTEXT: ExecutionContext = {
  tenantId: 't',
  userId: 'u',
  roles: [],
  sessionId: 's',
  agentId: 'a',
  requestId: 'r',
};

async function setup(stopWords?: StopWords, glossary?: GlossaryEntry[]) {
  const store = new InMemoryVectorStore();
  await store.createCollection('docs', {
    dimensions: 3,
    distanceMetric: 'cosine',
    embeddingProvider: 'mock',
    embeddingModel: 'mock/mock-v1',
  });
  await store.upsert('docs', [
    {
      id: 'a',
      content: 'facturas pendientes dólares',
      vector: [1, 0, 0],
      metadata: { documentId: 'da' },
    },
  ]);
  const hybrid = vi.spyOn(store, 'hybridSearch');
  const embedding = new EmbeddingRouter();
  const provider = new FixedEmbedding();
  embedding.registerProvider(provider);
  const rewriter = new RecordingRewriter();
  const pipeline = new RAGPipeline(
    embedding,
    store,
    undefined,
    new EventBus(),
    new TokenTracker(),
    rewriter,
    'require',
    {
      lexicon: {
        ...(stopWords !== undefined && { stopWords }),
        ...(glossary !== undefined && { glossary }),
      },
    },
  );
  return { pipeline, hybrid, provider, rewriter };
}

describe('RAGPipeline — lexicon', () => {
  it('sends the keyword component the text without stop words and embeds the full question', async () => {
    const { pipeline, hybrid, provider } = await setup(
      new StopWords({ stopWords: 'auto', languages: ['es'] }),
    );
    const result = await pipeline.search(
      { query: '¿Qué hago si me dan dólares falsos?', collections: ['docs'] },
      CONTEXT,
    );
    expect(hybrid.mock.calls[0]![2]).toBe('hago dan dólares falsos');
    expect(provider.texts[0]).toBe('¿Qué hago si me dan dólares falsos?');
    expect(result.trace.lexicon).toEqual({
      stopWords: 'query',
      keywordQuery: 'hago dan dólares falsos',
      stopWordsRemoved: 3,
      glossaryTerms: [],
    });
  });

  it('a search can name its languages', async () => {
    const { pipeline, hybrid } = await setup(
      new StopWords({ stopWords: 'auto', languages: ['es'] }),
    );
    await pipeline.search(
      { query: 'what is the policy', collections: ['docs'], languages: ['en'] },
      CONTEXT,
    );
    expect(hybrid.mock.calls[0]![2]).toBe('policy');
  });

  it('without stop words the keyword text is the query and there is no lexicon trace', async () => {
    const { pipeline, hybrid } = await setup();
    const result = await pipeline.search(
      { query: 'de la agencia', collections: ['docs'] },
      CONTEXT,
    );
    expect(hybrid.mock.calls[0]![2]).toBe('de la agencia');
    expect(result.trace.lexicon).toBeUndefined();
  });

  it('passes the glossary entries the question uses to the rewriter, search glossary over installation', async () => {
    const installation: GlossaryEntry[] = [
      { terms: ['ERP'], definition: 'old' },
      { terms: ['BPS'], definition: 'Banco de Previsión Social' },
    ];
    const { pipeline, rewriter } = await setup(undefined, installation);
    const result = await pipeline.search(
      {
        query: '¿cómo entro al ERP?',
        collections: ['docs'],
        glossary: [{ terms: ['ERP'], definition: 'Sistema de Planificación de Recursos' }],
      },
      CONTEXT,
    );
    expect(rewriter.calls[0]).toEqual({
      glossary: [{ terms: ['ERP'], definition: 'Sistema de Planificación de Recursos' }],
    });
    expect(result.trace.lexicon?.glossaryTerms).toEqual(['ERP']);
  });

  it('glossaryRewrite: false keeps the glossary away from a first question', async () => {
    const store = new InMemoryVectorStore();
    await store.createCollection('docs', {
      dimensions: 3,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock/mock-v1',
    });
    const embedding = new EmbeddingRouter();
    embedding.registerProvider(new FixedEmbedding());
    const rewriter = new RecordingRewriter();
    const pipeline = new RAGPipeline(
      embedding,
      store,
      undefined,
      new EventBus(),
      new TokenTracker(),
      rewriter,
      'require',
      {
        lexicon: {
          glossary: [{ terms: ['SLA'], definition: 'service level agreement' }],
          glossaryRewrite: false,
        },
      },
    );
    await pipeline.search({ query: 'what is the SLA?', collections: ['docs'] }, CONTEXT);
    expect(rewriter.calls[0]).toBeUndefined();
    await pipeline.search(
      {
        query: 'and for premium?',
        collections: ['docs'],
        conversationHistory: [{ role: 'user', content: 'what is the SLA?' }],
      },
      CONTEXT,
    );
    expect(rewriter.calls[1]?.glossary?.[0]?.terms).toEqual(['SLA']);
  });

  it('matches glossary terms of the last user turn for a follow-up', async () => {
    const { pipeline, rewriter } = await setup(undefined, [
      { terms: ['ERP'], definition: 'Sistema' },
    ]);
    await pipeline.search(
      {
        query: '¿y si está bloqueado?',
        collections: ['docs'],
        conversationHistory: [
          { role: 'user', content: '¿cómo entro al ERP?' },
          { role: 'assistant', content: 'Con tu usuario.' },
        ],
      },
      CONTEXT,
    );
    expect(rewriter.calls[0]?.glossary?.[0]?.terms).toEqual(['ERP']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rewriters, expander, tool
// ─────────────────────────────────────────────────────────────────────────────

function router(content: string): LLMRouter & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async () => ({
    content,
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }));
  return { call, getProvider: vi.fn(() => undefined) } as unknown as LLMRouter & {
    call: ReturnType<typeof vi.fn>;
  };
}

describe('glossary in rewriters and expander', () => {
  const glossary: GlossaryEntry[] = [
    { terms: ['ERP'], definition: 'Sistema de Planificación de Recursos' },
  ];

  it('the contextual rewriter runs without history when glossary terms are present', async () => {
    const r = router('¿Cómo entro al ERP (Sistema de Planificación de Recursos)?');
    const rewriter = new ContextualRewriter(r, 'p', 'm');
    expect((await rewriter.rewriteWithOutcome('¿cómo entro al ERP?')).applied).toBe(false);
    expect(r.call).not.toHaveBeenCalled();
    const outcome = await rewriter.rewriteWithOutcome('¿cómo entro al ERP?', undefined, {
      glossary,
    });
    expect(outcome).toEqual({
      query: '¿Cómo entro al ERP (Sistema de Planificación de Recursos)?',
      applied: true,
    });
    const req = r.call.mock.calls[0]![0];
    expect(req.systemPrompt).toContain('- ERP: Sistema de Planificación de Recursos');
    expect(req.messages[0].content).toContain('Conversation history:\n(none)');
  });

  it('the expander receives the glossary', async () => {
    const r = router('["Sistema de Planificación de Recursos acceso"]');
    await new QueryExpander(r, 'p', 'm').expand('¿cómo entro al ERP?', { glossary });
    expect(r.call.mock.calls[0]![0].systemPrompt).toContain('Domain glossary');
  });

  it('the RAG tool passes the host lexicon to the search', async () => {
    const search = vi.fn(async () => ({ passages: [], totalFound: 0 }));
    const pipeline = { search, formatForContext: () => '' } as unknown as RAGPipeline;
    const tool = createRAGTool(
      pipeline,
      ['docs'],
      {},
      {
        lexicon: () => ({ languages: ['es'], glossary }),
      },
    );
    await tool.execute({ query: 'ERP' }, CONTEXT);
    expect(search.mock.calls[0]![0]).toMatchObject({ languages: ['es'], glossary });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator — rag.lexicon', () => {
  it('loads the installation glossary file and reports unreadable lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lexicon-'));
    const file = join(dir, 'glossary.txt');
    writeFileSync(file, 'ERP = Sistema de Planificación de Recursos\nsolo\n');
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({ rag: { lexicon: { stopWords: 'auto', glossaryFile: file } } }).get(),
    );
    expect(orch.rag.pipeline.glossary).toEqual([
      { terms: ['ERP'], definition: 'Sistema de Planificación de Recursos' },
    ]);
    expect(orch.rag.pipeline.glossaryErrors.map((e) => e.line)).toEqual([2]);
  });

  it('a missing glossary file is a configuration error', async () => {
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({ rag: { lexicon: { glossaryFile: '/nonexistent/g.txt' } } }).get(),
    );
    expect(() => orch.rag).toThrow(ConfigError);
  });

  it('rejects an invalid stopWords value', () => {
    expect(() =>
      ConfigLoader.from({ rag: { lexicon: { stopWords: 'all' as 'auto' } } }).get(),
    ).toThrow(/rag.lexicon.stopWords/);
  });
});
