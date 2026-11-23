/**
 * RAG observability: search trace, query-rewrite outcome, model probes and the
 * audit records they produce. Offline — in-memory store and mock providers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { ContextualRewriter } from '../../../src/rag/queryRewriting/ContextualRewriter.js';
import { HyDERewriter } from '../../../src/rag/queryRewriting/HyDERewriter.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { EventCollector } from '../../../src/audit/EventCollector.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type {
  EmbeddingResult,
  RerankResult,
  Passage,
  VectorDocument,
} from '../../../src/rag/types.js';
import type {
  AuditRecord,
  ExecutionContext,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class FixedEmbedding extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/mock-v1';
  async embed(): Promise<EmbeddingResult> {
    return { vector: [1, 0, 0], model: 'mock-v1', dimensions: 3, tokensUsed: 1, latencyMs: 0 };
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

/** Scores passages from a fixed table and records the `topK` it was asked for. */
class TableReranker extends RerankerProvider {
  readonly name = 'table';
  requestedTopK: number | undefined;
  constructor(private readonly scores: Record<string, number>) {
    super();
  }
  async rerank(_q: string, passages: Passage[], topK: number): Promise<RerankResult> {
    this.requestedTopK = topK;
    const scored = passages
      .map((p) => ({ ...p, score: this.scores[p.id] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { passages: scored, model: 'table-v1', latencyMs: 0, tokensUsed: 0 };
  }
  async validate(): Promise<boolean> {
    return true;
  }
  override get model(): string {
    return 'table-v1';
  }
}

const COLLECTION = 'docs';
const CONTEXT: ExecutionContext = {
  tenantId: 't',
  userId: 'u',
  roles: [],
  sessionId: 's',
  agentId: 'a',
  requestId: 'r',
};

function doc(id: string, vector: number[], chunkIndex: number): VectorDocument {
  return {
    id,
    content: `content of ${id}`,
    vector,
    metadata: { documentId: `doc-${id}`, chunkIndex, title: `Title ${id}` },
  };
}

function makeRouter(impl: () => Promise<unknown>): LLMRouter {
  return { call: vi.fn().mockImplementation(impl) } as unknown as LLMRouter;
}

const okResponse = (content: string): Promise<unknown> =>
  Promise.resolve({ content, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });

// ─────────────────────────────────────────────────────────────────────────────
// RAGPipeline trace
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline trace', () => {
  let store: InMemoryVectorStore;
  let embedding: EmbeddingRouter;
  let bus: EventBus;
  let tokens: TokenTracker;

  beforeEach(async () => {
    store = new InMemoryVectorStore();
    await store.createCollection(COLLECTION, {
      dimensions: 3,
      distanceMetric: 'cosine',
      embeddingProvider: 'mock',
      embeddingModel: 'mock/mock-v1',
    });
    await store.upsert(COLLECTION, [
      doc('a', [1, 0, 0], 0),
      doc('b', [0.9, 0.1, 0], 1),
      doc('c', [0.5, 0.5, 0], 2),
      doc('d', [0, 1, 0], 3),
    ]);
    embedding = new EmbeddingRouter();
    embedding.registerProvider(new FixedEmbedding());
    bus = new EventBus();
    tokens = new TokenTracker();
  });

  it('records every candidate with its scores and where it ended up', async () => {
    const reranker = new TableReranker({ a: 0.9, b: 0.05, c: 0.6, d: 0.3 });
    const pipeline = new RAGPipeline(embedding, store, reranker, bus, tokens);

    const result = await pipeline.search(
      { query: 'q', collections: [COLLECTION], finalTopK: 3, minScore: 0.4, searchMode: 'vector' },
      CONTEXT,
    );

    // The re-ranker scores all candidates so the trace can explain the cut.
    expect(reranker.requestedTopK).toBe(4);
    expect(result.passages.map((p) => p.id)).toEqual(['a', 'c']);

    const { trace } = result;
    expect(trace.candidateCount).toBe(4);
    expect(trace.finalTopK).toBe(3);
    expect(trace.minScore).toBe(0.4);
    expect(trace.droppedByMinScore).toBe(1);
    expect(trace.candidates.map((c) => [c.id, c.stage])).toEqual([
      ['a', 'final'],
      ['c', 'final'],
      ['d', 'below_min_score'],
      ['b', 'beyond_final_top_k'],
    ]);
    const a = trace.candidates[0]!;
    expect(a).toMatchObject({ documentId: 'doc-a', chunkIndex: 0, rerankScore: 0.9 });
    expect(a.retrievalScore).toBeGreaterThan(0);
    // Identifiers and scores only — never passage text.
    expect(JSON.stringify(trace)).not.toContain('content of');
  });

  it('omits rerank scores when the search is not re-ranked', async () => {
    const pipeline = new RAGPipeline(embedding, store, undefined, bus, tokens);
    const { trace } = await pipeline.search(
      { query: 'q', collections: [COLLECTION], finalTopK: 2, searchMode: 'vector' },
      CONTEXT,
    );
    expect(trace.candidates).toHaveLength(4);
    expect(trace.candidates.every((c) => c.rerankScore === undefined)).toBe(true);
    expect(trace.candidates.filter((c) => c.stage === 'final')).toHaveLength(2);
    expect(trace.rewrite).toBeUndefined();
  });

  it('reports the post-minScore count and the trace on rag.pipeline.complete', async () => {
    const reranker = new TableReranker({ a: 0.9, b: 0.05, c: 0.05, d: 0.05 });
    const pipeline = new RAGPipeline(embedding, store, reranker, bus, tokens);
    const events: Record<string, unknown>[] = [];
    bus.on('rag.pipeline.complete', (e) => events.push(e.data as Record<string, unknown>));
    const rerankEnd: Record<string, unknown>[] = [];
    bus.on('rag.rerank.end', (e) => rerankEnd.push(e.data as Record<string, unknown>));

    await pipeline.search(
      { query: 'q', collections: [COLLECTION], finalTopK: 3, minScore: 0.5, searchMode: 'vector' },
      CONTEXT,
    );

    expect(rerankEnd[0]).toMatchObject({ finalCount: 3, candidateCount: 4 });
    expect(events[0]).toMatchObject({ passageCount: 1, droppedByMinScore: 2 });
    expect(events[0]!.trace).toBeDefined();
  });

  it('records a rewrite fallback in the trace and on rag.query_rewrite.end', async () => {
    const router = makeRouter(() => Promise.reject(new Error('403 no access to model x')));
    const rewriter = new ContextualRewriter(router, 'openai', 'model-x');
    const pipeline = new RAGPipeline(embedding, store, undefined, bus, tokens, rewriter);
    const events: Record<string, unknown>[] = [];
    bus.on('rag.query_rewrite.end', (e) => events.push(e.data as Record<string, unknown>));

    const result = await pipeline.search(
      {
        query: 'And who signs it?',
        collections: [COLLECTION],
        conversationHistory: [{ role: 'user', content: 'What about the receipt?' }],
      },
      CONTEXT,
    );

    expect(result.trace.searchQuery).toBe('And who signs it?');
    expect(result.trace.rewrite).toMatchObject({
      strategy: 'contextual',
      applied: false,
      fallbackReason: 'error',
      error: '403 no access to model x',
    });
    expect(events[0]).toMatchObject({
      strategy: 'contextual',
      model: 'model-x',
      applied: false,
      fallbackReason: 'error',
    });
  });

  it('records an applied rewrite', async () => {
    const router = makeRouter(() => okResponse('Who signs the retention receipt?'));
    const rewriter = new ContextualRewriter(router, 'openai', 'model-x');
    const pipeline = new RAGPipeline(embedding, store, undefined, bus, tokens, rewriter);

    const { trace } = await pipeline.search(
      {
        query: 'And who signs it?',
        collections: [COLLECTION],
        conversationHistory: [{ role: 'user', content: 'What about the receipt?' }],
      },
      CONTEXT,
    );

    expect(trace.originalQuery).toBe('And who signs it?');
    expect(trace.searchQuery).toBe('Who signs the retention receipt?');
    expect(trace.rewrite).toEqual({ strategy: 'contextual', applied: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatForContext source label
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline.formatForContext() source label', () => {
  const passage: Passage = {
    id: 'p',
    content: 'Retain the banknote.',
    score: 1,
    collection: COLLECTION,
    metadata: {
      documentId: 'd1',
      title: 'Annex XXII - Counterfeit',
      source: '/srv/file/abc/x.pdf',
    },
  };
  const pipeline = new RAGPipeline(
    new EmbeddingRouter(),
    new InMemoryVectorStore(),
    undefined,
    new EventBus(),
    new TokenTracker(),
  );

  it('labels passages with the title by default, keeping internal paths out', () => {
    const out = pipeline.formatForContext([passage]);
    expect(out).toContain('Source: Annex XXII - Counterfeit');
    expect(out).not.toContain('/srv/file');
  });

  it('uses the source reference when asked to', () => {
    expect(pipeline.formatForContext([passage], { sourceLabel: 'source' })).toContain(
      'Source: /srv/file/abc/x.pdf',
    );
  });

  it('falls back to source, then documentId, when there is no title', () => {
    const noTitle = { ...passage, metadata: { documentId: 'd1', source: 'https://x' } };
    expect(pipeline.formatForContext([noTitle])).toContain('Source: https://x');
    const bare = { ...passage, metadata: { documentId: 'd1' } };
    expect(pipeline.formatForContext([bare])).toContain('Source: d1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Query rewriter outcome and validate()
// ─────────────────────────────────────────────────────────────────────────────

describe('Query rewriter outcome and probe', () => {
  const history = [{ role: 'user' as const, content: 'Tell me about Plan A' }];

  it('ContextualRewriter reports a skipped rewrite without history (no fallback)', async () => {
    const rewriter = new ContextualRewriter(
      makeRouter(() => okResponse('x')),
      'p',
      'm',
    );
    expect(await rewriter.rewriteWithOutcome('q')).toEqual({ query: 'q', applied: false });
  });

  it('ContextualRewriter reports empty replies with the token-limit hint', async () => {
    const router = makeRouter(() =>
      Promise.resolve({
        content: '',
        stopReason: 'max_tokens',
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    );
    const rewriter = new ContextualRewriter(router, 'p', 'm');
    const outcome = await rewriter.rewriteWithOutcome('q', history);
    expect(outcome).toMatchObject({ query: 'q', applied: false, fallbackReason: 'empty' });
    expect(outcome.error).toContain('token limit');

    const probe = await rewriter.validate();
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("model 'm' returned an empty rewrite");
  });

  it('ContextualRewriter.validate() fails with the provider error', async () => {
    const rewriter = new ContextualRewriter(
      makeRouter(() => Promise.reject(new Error('403 does not have access to model m'))),
      'openai',
      'm',
    );
    expect(await rewriter.validate()).toEqual({
      ok: false,
      error: '403 does not have access to model m',
    });
    expect(rewriter.provider).toBe('openai');
    expect(rewriter.model).toBe('m');
  });

  it('ContextualRewriter.validate() succeeds on a real rewrite', async () => {
    const rewriter = new ContextualRewriter(
      makeRouter(() => okResponse('How much does the Pro plan cost?')),
      'p',
      'm',
    );
    expect(await rewriter.validate()).toEqual({ ok: true });
  });

  it('HyDERewriter reports outcome and probes', async () => {
    const good = new HyDERewriter(
      makeRouter(() => okResponse('The Pro plan costs 20 dollars per user per month.')),
      'p',
      'm',
    );
    expect(await good.rewriteWithOutcome('q')).toMatchObject({ applied: true });
    expect(await good.validate()).toEqual({ ok: true });

    const short = new HyDERewriter(
      makeRouter(() => okResponse('ok')),
      'p',
      'm',
    );
    expect(await short.rewriteWithOutcome('q')).toMatchObject({
      query: 'q',
      applied: false,
      fallbackReason: 'too_short',
    });
    expect((await short.validate()).ok).toBe(false);
  });

  it('RAGPipeline.validateQueryRewriter() reports configuration and failure', async () => {
    const bus = new EventBus();
    const unavailable: Record<string, unknown>[] = [];
    bus.on('rag.query_rewriter.unavailable', (e) =>
      unavailable.push(e.data as Record<string, unknown>),
    );

    const none = new RAGPipeline(
      new EmbeddingRouter(),
      new InMemoryVectorStore(),
      undefined,
      bus,
      new TokenTracker(),
    );
    expect(await none.validateQueryRewriter()).toEqual({ configured: false, available: false });

    const failing = new ContextualRewriter(
      makeRouter(() => Promise.reject(new Error('403'))),
      'openai',
      'gpt-x',
    );
    const pipeline = new RAGPipeline(
      new EmbeddingRouter(),
      new InMemoryVectorStore(),
      undefined,
      bus,
      new TokenTracker(),
      failing,
    );
    const v = await pipeline.validateQueryRewriter();
    expect(v).toMatchObject({
      configured: true,
      strategy: 'contextual',
      provider: 'openai',
      model: 'gpt-x',
      available: false,
      error: '403',
    });
    expect(unavailable[0]).toMatchObject({ strategy: 'contextual', model: 'gpt-x', error: '403' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('EventCollector — RAG observability events', () => {
  let bus: EventBus;
  let logs: Partial<AuditRecord>[];

  beforeEach(() => {
    bus = new EventBus();
    logs = [];
    new EventCollector(bus, (p) => logs.push(p)).start();
  });

  it('records a rewrite fallback as a failure, not a success', () => {
    bus.emit('rag.query_rewrite.end', {
      latencyMs: 300,
      strategy: 'contextual',
      model: 'gpt-x',
      applied: false,
      fallbackReason: 'error',
      error: '403',
    });
    expect(logs[0]).toMatchObject({
      action: 'query_rewrite',
      outcome: 'failure',
      severity: 'warning',
      detail: { output: { fallbackReason: 'error', model: 'gpt-x' }, error: '403' },
    });
  });

  it('records an applied rewrite as a success', () => {
    bus.emit('rag.query_rewrite.end', { latencyMs: 900, strategy: 'contextual', applied: true });
    expect(logs[0]).toMatchObject({
      action: 'query_rewrite',
      outcome: 'success',
      severity: 'info',
    });
  });

  it('includes the post-cut count and candidate scores in search_complete', () => {
    bus.emit('rag.pipeline.complete', {
      totalLatencyMs: 10,
      metrics: { embeddingLatencyMs: 1 },
      passageCount: 1,
      droppedByMinScore: 2,
      trace: {
        originalQuery: 'secret question',
        searchQuery: 'secret question',
        minScore: 0.25,
        finalTopK: 5,
        candidateCount: 3,
        droppedByMinScore: 2,
        candidates: [
          { id: 'x', documentId: 'd', retrievalScore: 1, rerankScore: 0.9, stage: 'final' },
        ],
      },
    });
    const out = logs[0]!.detail!.output as Record<string, unknown>;
    expect(out).toMatchObject({
      embeddingLatencyMs: 1,
      passageCount: 1,
      droppedByMinScore: 2,
      minScore: 0.25,
      candidateCount: 3,
    });
    expect(out.candidates).toHaveLength(1);
    // The query text stays out of the audit log.
    expect(JSON.stringify(logs[0])).not.toContain('secret question');
  });

  it('records unavailable models as errors', () => {
    bus.emit('rag.query_rewriter.unavailable', {
      strategy: 'contextual',
      model: 'gpt-x',
      error: '403',
    });
    bus.emit('rag.reranker.unavailable', { provider: 'llm', error: 'timeout' });
    bus.emit('model.unavailable', {
      role: 'llm',
      provider: 'openai',
      model: 'gpt-y',
      error: '401',
    });
    expect(logs.map((l) => [l.action, l.outcome])).toEqual([
      ['query_rewriter_unavailable', 'error'],
      ['reranker_unavailable', 'error'],
      ['model_unavailable', 'error'],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator.validateModels()
// ─────────────────────────────────────────────────────────────────────────────

class ScriptedProvider extends LLMProvider {
  readonly name = 'mock';
  readonly providerType = 'mock';
  constructor(private readonly failModels: string[] = []) {
    super();
  }
  override async call(req: LLMRequest): Promise<LLMResponse> {
    if (this.failModels.includes(req.model)) {
      throw new Error(`403 Project does not have access to model ${req.model}`);
    }
    return {
      content: 'OK rewritten query',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: req.model,
      provider: 'mock',
      latencyMs: 0,
    };
  }
  override async validate(): Promise<boolean> {
    return true;
  }
  override async listModels(): Promise<string[]> {
    return [];
  }
  override capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

describe('Orchestrator.validateModels()', () => {
  async function makeOrch(failModels: string[]): Promise<Orchestrator> {
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({
        llm: { defaultProvider: 'mock', defaultModel: 'main-model' },
        rag: {
          queryRewriting: { strategy: 'contextual', llmProvider: 'mock', model: 'rewrite-model' },
        },
      }).get(),
    );
    orch.registerProvider(new ScriptedProvider(failModels));
    return orch;
  }

  it('reports every role and is ok when all configured models answer', async () => {
    const orch = await makeOrch([]);
    const report = await orch.validateModels();
    expect(report.models.map((m) => m.role)).toEqual([
      'llm',
      'embedding',
      'reranker',
      'queryRewriter',
      'queryExpander',
      'verifier',
      'documentIdentifier',
    ]);
    expect(report.models[0]).toMatchObject({
      provider: 'mock',
      model: 'main-model',
      configured: true,
      available: true,
    });
    expect(report.models[2]).toMatchObject({ configured: false, available: false });
    expect(report.models[3]).toMatchObject({
      model: 'rewrite-model',
      configured: true,
      available: true,
    });
    expect(report.ok).toBe(report.models.every((m) => !m.configured || m.available));
  });

  it('flags a rewriter model the credentials cannot access', async () => {
    const orch = await makeOrch(['rewrite-model']);
    const report = await orch.validateModels();
    const rewriter = report.models.find((m) => m.role === 'queryRewriter')!;
    expect(rewriter).toMatchObject({ configured: true, available: false });
    expect(rewriter.error).toContain('does not have access to model rewrite-model');
    expect(report.ok).toBe(false);
  });

  it('resolves the LLM model from the provider default when llm.defaultModel is unset', async () => {
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({
        llm: {
          defaultProvider: 'mock',
          providers: { mock: { type: 'openai', apiKey: 'test', defaultModel: 'provider-model' } },
        },
      }).get(),
    );
    orch.registerProvider(new ScriptedProvider());
    const report = await orch.validateModels({ rag: false });
    expect(report.models[0]).toMatchObject({
      role: 'llm',
      model: 'provider-model',
      configured: true,
      available: true,
    });
  });

  it('flags the default LLM and emits model.unavailable', async () => {
    const orch = await makeOrch(['main-model']);
    const events: Record<string, unknown>[] = [];
    orch.events.on('model.unavailable', (e) => events.push(e.data as Record<string, unknown>));
    const report = await orch.validateModels({ rag: false });
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({ role: 'llm', available: false });
    expect(events[0]).toMatchObject({ role: 'llm', model: 'main-model' });
  });
});
