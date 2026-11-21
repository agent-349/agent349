/**
 * Multi-query retrieval: QueryExpander and the pipeline's expansion modes
 * (off, fallback, always), fusion, per-query override, cap and failures.
 * Offline — in-memory store, mock embedding, table re-ranker, mock router.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { QueryExpander } from '../../../src/rag/queryRewriting/QueryExpander.js';
import { fuseRankedLists } from '../../../src/rag/fusion/RRF.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { EmbeddingResult, Passage, RerankResult } from '../../../src/rag/types.js';
import type { ExecutionContext, LLMResponse } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Maps each text to a fixed vector; anything else points at `a`. */
class MapEmbedding extends EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock/mock-v1';
  constructor(private readonly vectors: Record<string, number[]>) {
    super();
  }
  async embed(text: string): Promise<EmbeddingResult> {
    return {
      vector: this.vectors[text] ?? [1, 0, 0],
      model: 'mock-v1',
      dimensions: 3,
      tokensUsed: 1,
      latencyMs: 0,
    };
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

class TableReranker extends RerankerProvider {
  readonly name = 'table';
  readonly calls: string[][] = [];
  constructor(private readonly scores: Record<string, number>) {
    super();
  }
  async rerank(_q: string, passages: Passage[], topK: number): Promise<RerankResult> {
    this.calls.push(passages.map((p) => p.id));
    const scored = passages
      .map((p) => ({ ...p, score: this.scores[p.id] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { passages: scored, model: 'table-v1', latencyMs: 0, tokensUsed: 0 };
  }
  async validate(): Promise<boolean> {
    return true;
  }
}

function routerReplying(
  reply: Partial<LLMResponse> | Error,
): LLMRouter & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return {
      content: '',
      stopReason: 'end',
      usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      ...reply,
    };
  });
  return { call, getProvider: vi.fn(() => undefined) } as unknown as LLMRouter & {
    call: ReturnType<typeof vi.fn>;
  };
}

const CONTEXT: ExecutionContext = {
  tenantId: 't',
  userId: 'u',
  roles: [],
  sessionId: 's',
  agentId: 'a',
  requestId: 'r',
};
const COL = 'docs';

async function makeStore(): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore();
  await store.createCollection(COL, {
    dimensions: 3,
    distanceMetric: 'cosine',
    embeddingProvider: 'mock',
    embeddingModel: 'mock/mock-v1',
  });
  await store.upsert(COL, [
    { id: 'a', content: 'passage a', vector: [1, 0, 0], metadata: { documentId: 'da' } },
    { id: 'b', content: 'passage b', vector: [0, 1, 0], metadata: { documentId: 'db' } },
    { id: 'c', content: 'passage c', vector: [0, 0, 1], metadata: { documentId: 'dc' } },
  ]);
  return store;
}

// The plain query finds only `a` (topK 1); the variant "formal q" finds only `b`.
const VECTORS = { q: [1, 0, 0], 'formal q': [0, 1, 0], 'q keywords': [0, 0, 1] };

// ─────────────────────────────────────────────────────────────────────────────
// QueryExpander
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryExpander', () => {
  it('returns distinct variants, dropping the original and duplicates, capped', async () => {
    const router = routerReplying({
      content: JSON.stringify({
        queries: ['formal q', 'Q', 'formal  q', 'q keywords', 'extra one'],
      }),
    });
    const expander = new QueryExpander(router, 'openai', 'gpt-6-luna', { variants: 2 });
    const outcome = await expander.expand('q');
    expect(outcome.variants).toEqual(['formal q', 'q keywords']);
    expect(outcome.inputTokens).toBe(40);
  });

  it('reads the structured answer and a bare JSON array', async () => {
    const structured = routerReplying({
      content: '',
      structured: {
        mode: 'native_schema',
        parsed: true,
        value: { queries: ['v1'] },
        validation: 'skipped',
      },
    });
    expect((await new QueryExpander(structured, 'p', 'm').expand('q')).variants).toEqual(['v1']);
    const bare = routerReplying({ content: 'Here: ["v2", "v3"]' });
    expect((await new QueryExpander(bare, 'p', 'm').expand('q')).variants).toEqual(['v2', 'v3']);
  });

  it('never throws: errors and unparseable replies come back as no variants', async () => {
    const failing = new QueryExpander(routerReplying(new Error('403 no access')), 'p', 'm');
    expect(await failing.expand('q')).toEqual({ variants: [], error: '403 no access' });
    const garbage = new QueryExpander(routerReplying({ content: 'sorry' }), 'p', 'm');
    expect((await garbage.expand('q')).error).toContain('did not return a list of queries');
    expect((await failing.validate()).ok).toBe(false);
  });

  it('passes the collection context and asks for the configured number of variants', async () => {
    const router = routerReplying({ content: '["v"]' });
    await new QueryExpander(router, 'p', 'm', {
      variants: 4,
      context: 'Operating rules of payment agencies.',
    }).expand('q');
    const req = router.call.mock.calls[0]![0];
    expect(req.systemPrompt).toContain(
      'About the collection: Operating rules of payment agencies.',
    );
    expect(req.messages[0].content).toContain('Write 4 alternative queries');
    expect(req.reasoningEffort).toBe('minimal');
  });
});

describe('fuseRankedLists', () => {
  it('sums reciprocal ranks across lists and keeps the first copy', () => {
    const p = (id: string, score: number): Passage => ({
      id,
      content: id,
      score,
      collection: 'c',
      metadata: { documentId: id },
    });
    const fused = fuseRankedLists([
      [p('a', 0.9), p('b', 0.5)],
      [p('b', 0.99), p('c', 0.1)],
    ]);
    expect(fused.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]!.score).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RAGPipeline expansion modes
// ─────────────────────────────────────────────────────────────────────────────

describe('RAGPipeline — query expansion', () => {
  let store: InMemoryVectorStore;
  let embedding: EmbeddingRouter;
  let bus: EventBus;

  beforeEach(async () => {
    store = await makeStore();
    embedding = new EmbeddingRouter();
    embedding.registerProvider(new MapEmbedding(VECTORS));
    bus = new EventBus();
  });

  const expanderFor = (queries: string[]): QueryExpander =>
    new QueryExpander(
      routerReplying({ content: JSON.stringify({ queries }) }),
      'openai',
      'gpt-6-luna',
    );

  const search = (pipeline: RAGPipeline, extra: Record<string, unknown> = {}) =>
    pipeline.search(
      {
        query: 'q',
        collections: [COL],
        topK: 1,
        finalTopK: 3,
        minScore: 0.5,
        searchMode: 'vector',
        ...extra,
      },
      CONTEXT,
    );

  it('is off by default even with an expander', async () => {
    const reranker = new TableReranker({ a: 0.1, b: 0.9 });
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
      },
    );
    const result = await search(pipeline);
    expect(result.passages).toEqual([]);
    expect(result.trace.expansion).toBeUndefined();
    expect(reranker.calls).toHaveLength(1);
  });

  it("'always' searches the variants and re-ranks the fused candidates once", async () => {
    const reranker = new TableReranker({ a: 0.1, b: 0.9 });
    const events: Record<string, unknown>[] = [];
    bus.on('rag.query_expansion.end', (e) => events.push(e.data as Record<string, unknown>));
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
        expansion: { mode: 'always' },
      },
    );

    const result = await search(pipeline);

    expect(reranker.calls).toEqual([['a', 'b']]);
    expect(result.passages.map((p) => p.id)).toEqual(['b']);
    expect(result.trace.expansion).toMatchObject({
      mode: 'always',
      triggered: true,
      reason: 'always',
      variants: ['formal q'],
      candidatesBefore: 1,
      candidatesAfter: 2,
    });
    const b = result.trace.candidates.find((c) => c.id === 'b')!;
    expect(b.foundBy).toEqual([1]);
    expect(result.trace.candidates.find((c) => c.id === 'a')!.foundBy).toEqual([0]);
    expect(events[0]).toMatchObject({
      mode: 'always',
      reason: 'always',
      variants: 1,
      model: 'gpt-6-luna',
    });
    expect(result.metrics.expansionLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("'fallback' does nothing when a candidate reaches the threshold", async () => {
    const reranker = new TableReranker({ a: 0.8 });
    const expander = expanderFor(['formal q']);
    const spy = vi.spyOn(expander, 'expand');
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expander,
        expansion: { mode: 'fallback' },
      },
    );

    const result = await search(pipeline);

    expect(spy).not.toHaveBeenCalled();
    expect(reranker.calls).toHaveLength(1);
    expect(result.passages.map((p) => p.id)).toEqual(['a']);
    expect(result.trace.expansion).toMatchObject({
      mode: 'fallback',
      triggered: false,
      variants: [],
    });
  });

  it("'fallback' expands and re-ranks when nothing reaches the threshold", async () => {
    const reranker = new TableReranker({ a: 0.1, b: 0.9 });
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
        expansion: { mode: 'fallback' },
      },
    );

    const result = await search(pipeline);

    expect(reranker.calls).toEqual([['a'], ['a', 'b']]);
    expect(result.passages.map((p) => p.id)).toEqual(['b']);
    expect(result.trace.expansion).toMatchObject({ triggered: true, reason: 'below_threshold' });
  });

  it('uses fallbackBelow instead of minScore when set', async () => {
    const reranker = new TableReranker({ a: 0.6, b: 0.9 });
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
        expansion: { mode: 'fallback', fallbackBelow: 0.7 },
      },
    );
    const result = await search(pipeline);
    expect(result.trace.expansion?.triggered).toBe(true);
    expect(result.passages.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('a search can ask for expansion with RAGQuery.expansion', async () => {
    const reranker = new TableReranker({ a: 0.1, b: 0.9 });
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
      },
    );
    const result = await search(pipeline, { expansion: 'always' });
    expect(result.trace.expansion?.reason).toBe('always');
    expect(result.passages.map((p) => p.id)).toEqual(['b']);
  });

  it('caps the fused candidates with maxCandidates', async () => {
    const reranker = new TableReranker({ a: 0.1, b: 0.9, c: 0.95 });
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q', 'q keywords']),
        expansion: { mode: 'always', maxCandidates: 2 },
      },
    );
    const result = await search(pipeline);
    expect(reranker.calls[0]).toHaveLength(2);
    expect(result.trace.expansion?.candidatesAfter).toBe(2);
  });

  it('goes on without variants when the expander fails, without a second re-rank', async () => {
    const reranker = new TableReranker({ a: 0.1 });
    const failing = new QueryExpander(routerReplying(new Error('timeout')), 'openai', 'gpt-6-luna');
    const pipeline = new RAGPipeline(
      embedding,
      store,
      reranker,
      bus,
      new TokenTracker(),
      undefined,
      'require',
      {
        queryExpander: failing,
        expansion: { mode: 'fallback' },
      },
    );
    const result = await search(pipeline);
    expect(reranker.calls).toHaveLength(1);
    expect(result.passages).toEqual([]);
    expect(result.trace.expansion).toMatchObject({
      triggered: true,
      variants: [],
      error: 'timeout',
    });
  });

  it('records the expansion tokens', async () => {
    const tokens = new TokenTracker();
    const pipeline = new RAGPipeline(
      embedding,
      store,
      new TableReranker({ a: 0.1, b: 0.9 }),
      bus,
      tokens,
      undefined,
      'require',
      {
        queryExpander: expanderFor(['formal q']),
        expansion: { mode: 'always' },
      },
    );
    await search(pipeline);
    const summary = await tokens.getByUser('t', 'u', {
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(summary.byModel['gpt-6-luna']?.tokens).toBe(50);
  });
});

describe('Orchestrator — rag.queryExpansion', () => {
  it('builds the expander from config (off by default) and validates it', async () => {
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({
        rag: { queryExpansion: { llmProvider: 'nope', model: 'gpt-6-luna', variants: 2 } },
      }).get(),
    );
    expect(orch.rag.pipeline.queryExpander?.model).toBe('gpt-6-luna');
    expect(orch.rag.pipeline.queryExpander?.variants).toBe(2);
    const report = await orch.validateModels({ rag: true });
    const expander = report.models.find((m) => m.role === 'queryExpander')!;
    expect(expander).toMatchObject({ configured: true, available: false, model: 'gpt-6-luna' });
  });

  it('rejects an invalid mode', () => {
    expect(() =>
      ConfigLoader.from({ rag: { queryExpansion: { mode: 'sometimes' as 'off' } } }).get(),
    ).toThrow(/rag.queryExpansion.mode/);
  });
});
