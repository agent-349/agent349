/**
 * Regressions found against OpenAI reasoning models (gpt-5, gpt-5-mini,
 * gpt-5-nano), which reason by default and share the completion budget
 * between hidden reasoning and the visible reply:
 *
 * 1. `LLMReranker.validate()` sent 16 tokens and no reasoning effort; the
 *    model spent them reasoning, replied empty, and the probe still reported
 *    `ok: true` because it only checked that the call did not throw.
 * 2. The query rewriters sent no reasoning effort within 150/200 tokens, got
 *    an empty reply and silently searched with the original query.
 * 3. `createRAGTool` never passed conversation history, so a contextual
 *    rewriter was a no-op for agentic (tool-driven) retrieval.
 */
import { describe, it, expect, vi } from 'vitest';

import { LLMReranker } from '../../../src/rag/reranker/LLMReranker.js';
import { ContextualRewriter } from '../../../src/rag/queryRewriting/ContextualRewriter.js';
import { HyDERewriter } from '../../../src/rag/queryRewriting/HyDERewriter.js';
import { QueryRewriter } from '../../../src/rag/queryRewriting/QueryRewriter.js';
import { InMemoryVectorStore } from '../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { EmbeddingRouter } from '../../../src/rag/embedding/EmbeddingRouter.js';
import { EmbeddingProvider } from '../../../src/rag/embedding/EmbeddingProvider.js';
import { RAGPipeline } from '../../../src/rag/RAGPipeline.js';
import { createRAGTool } from '../../../src/rag/RAGTool.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { EmbeddingResult, ProviderProbe } from '../../../src/rag/types.js';
import type { ExecutionContext, LLMMessage, LLMRequest } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Reply = { content: string; stopReason?: string } | Error;

function makeRouter(...replies: Reply[]): LLMRouter & { call: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    call: vi.fn(async () => {
      const reply = replies[Math.min(i++, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return {
        content: reply.content,
        stopReason: reply.stopReason ?? 'end',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }),
  } as unknown as LLMRouter & { call: ReturnType<typeof vi.fn> };
}

function sentRequest(router: { call: ReturnType<typeof vi.fn> }, n = 0): LLMRequest {
  return router.call.mock.calls[n]![0] as LLMRequest;
}

function captureEvents(bus: EventBus, type: string): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  bus.on(type, (event) => seen.push(event.data as Record<string, unknown>));
  return seen;
}

const HISTORY: LLMMessage[] = [
  { role: 'user', content: 'Tell me about the Pro plan' },
  { role: 'assistant', content: 'The Pro plan includes priority support.' },
];

const CONTEXT: ExecutionContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  roles: ['reader'],
  sessionId: 'sess-1',
  agentId: 'agent-1',
  requestId: 'req-1',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. LLMReranker.validate()
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMReranker.validate — probes the real scoring call', () => {
  it('sends the scoring prompt with the scoring budget and reasoning effort', async () => {
    const router = makeRouter({ content: '[0.95]' });
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'gpt-5-nano',
    });

    expect(await reranker.validate()).toEqual({ ok: true });

    const request = sentRequest(router);
    expect(request.model).toBe('gpt-5-nano');
    expect(request.reasoningEffort).toBe('minimal');
    expect(request.maxTokens).toBe(1 * 8 + 256);
    expect(request.temperature).toBe(0);
    expect(request.systemPrompt).toContain('strict passage relevance scorer');
    expect(router.call.mock.calls[0]![1]).toBe('openai');
  });

  it('honours the configured maxTokens and reasoningEffort', async () => {
    const router = makeRouter({ content: '[1.0]' });
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'gpt-5',
      maxTokens: 1024,
      reasoningEffort: 'low',
    });

    await reranker.validate();

    expect(sentRequest(router).maxTokens).toBe(1024);
    expect(sentRequest(router).reasoningEffort).toBe('low');
  });

  it('reports unavailable when the reply is empty because the token limit was hit', async () => {
    const router = makeRouter({ content: '', stopReason: 'max_tokens' });
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'gpt-5-nano',
    });

    const probe = await reranker.validate();

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("model 'gpt-5-nano' did not return a score");
    expect(probe.error).toContain('token limit');
  });

  it('reports unavailable when the reply is not a score', async () => {
    const router = makeRouter({ content: 'I cannot help with that.' });
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });

    const probe = await reranker.validate();

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('I cannot help');
  });

  it('reports unavailable when the call fails', async () => {
    const router = makeRouter(new Error('401 invalid api key'));
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });

    expect(await reranker.validate()).toEqual({ ok: false, error: '401 invalid api key' });
  });

  it('does not emit rag.rerank.parse_error or apply the degrade fallback', async () => {
    const bus = new EventBus();
    const parseErrors = captureEvents(bus, 'rag.rerank.parse_error');
    const router = makeRouter({ content: 'no idea' });
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'm',
      eventBus: bus,
      onParseFailure: 'degrade',
    });

    expect((await reranker.validate()).ok).toBe(false);
    expect(parseErrors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Query rewriters
// ─────────────────────────────────────────────────────────────────────────────

describe('query rewriters — reasoning effort and fallback events', () => {
  it('ContextualRewriter asks for minimal reasoning by default', async () => {
    const router = makeRouter({ content: 'What does the Pro plan cost?' });
    const rewriter = new ContextualRewriter(router, 'openai', 'gpt-5-mini');

    expect(await rewriter.rewrite('and how much is it?', HISTORY)).toBe(
      'What does the Pro plan cost?',
    );
    expect(sentRequest(router).reasoningEffort).toBe('minimal');
    expect(sentRequest(router).maxTokens).toBe(150);
  });

  it('the reasoning effort can be changed or omitted', async () => {
    const low = makeRouter({ content: 'x query' });
    await new ContextualRewriter(low, 'p', 'm', 6, { reasoningEffort: 'low' }).rewrite(
      'q',
      HISTORY,
    );
    expect(sentRequest(low).reasoningEffort).toBe('low');

    const none = makeRouter({ content: 'x query' });
    await new HyDERewriter(none, 'p', 'm', { reasoningEffort: null }).rewrite('q');
    expect(sentRequest(none)).not.toHaveProperty('reasoningEffort');

    const hyde = makeRouter({ content: 'The Pro plan costs 20 dollars per user and month.' });
    await new HyDERewriter(hyde, 'p', 'm').rewrite('q');
    expect(sentRequest(hyde).reasoningEffort).toBe('minimal');
  });

  it('an empty reply keeps the query and emits rag.query_rewrite.fallback with the stop reason', async () => {
    const bus = new EventBus();
    const fallbacks = captureEvents(bus, 'rag.query_rewrite.fallback');
    const router = makeRouter({ content: '', stopReason: 'max_tokens' });
    const rewriter = new ContextualRewriter(router, 'openai', 'gpt-5-mini', 6, { eventBus: bus });

    expect(await rewriter.rewrite('and how much is it?', HISTORY)).toBe('and how much is it?');
    expect(fallbacks).toEqual([
      {
        strategy: 'contextual',
        provider: 'openai',
        model: 'gpt-5-mini',
        reason: 'empty',
        stopReason: 'max_tokens',
      },
    ]);
  });

  it('a failed call and a too-short HyDE passage are reported too', async () => {
    const bus = new EventBus();
    const fallbacks = captureEvents(bus, 'rag.query_rewrite.fallback');

    const failing = new ContextualRewriter(makeRouter(new Error('boom')), 'p', 'm', 6, {
      eventBus: bus,
    });
    expect(await failing.rewrite('q', HISTORY)).toBe('q');

    const short = new HyDERewriter(makeRouter({ content: 'Too short.' }), 'p', 'm', {
      eventBus: bus,
    });
    expect(await short.rewrite('q')).toBe('q');

    expect(fallbacks.map((f) => [f['strategy'], f['reason'], f['error']])).toEqual([
      ['contextual', 'error', 'boom'],
      ['hyde', 'too_short', undefined],
    ]);
  });

  it('no history is not a fallback: no call, no event', async () => {
    const bus = new EventBus();
    const fallbacks = captureEvents(bus, 'rag.query_rewrite.fallback');
    const router = makeRouter({ content: 'unused' });

    await new ContextualRewriter(router, 'p', 'm', 6, { eventBus: bus }).rewrite('q', []);

    expect(router.call).not.toHaveBeenCalled();
    expect(fallbacks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. createRAGTool — conversation history for the rewriter
// ─────────────────────────────────────────────────────────────────────────────

class MockEmbeddingProvider extends EmbeddingProvider {
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
  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }
}

class RecordingRewriter extends QueryRewriter {
  readonly name = 'recording';
  readonly histories: Array<LLMMessage[] | undefined> = [];
  async rewrite(query: string, conversationHistory?: LLMMessage[]): Promise<string> {
    this.histories.push(conversationHistory);
    return query;
  }
}

async function makePipeline(rewriter?: QueryRewriter): Promise<RAGPipeline> {
  const store = new InMemoryVectorStore();
  await store.createCollection('default', {
    dimensions: 3,
    distanceMetric: 'cosine',
    embeddingProvider: 'mock',
    embeddingModel: 'mock/mock-v1',
  });
  await store.upsert('default', [
    {
      id: 'd1',
      content: 'Pro plan pricing',
      vector: [1, 0, 0],
      metadata: { documentId: 'd1', tenantId: 'tenant-1' },
    },
  ]);
  const embeddings = new EmbeddingRouter();
  embeddings.registerProvider(new MockEmbeddingProvider());
  return new RAGPipeline(
    embeddings,
    store,
    undefined,
    new EventBus(),
    new TokenTracker(),
    rewriter,
  );
}

describe('createRAGTool — conversation history', () => {
  it("passes the caller's history to the query rewriter", async () => {
    const rewriter = new RecordingRewriter();
    const loader = vi.fn(async () => HISTORY);
    const tool = createRAGTool(
      await makePipeline(rewriter),
      ['default'],
      {},
      { conversationHistory: loader },
    );

    const result = await tool.execute({ query: 'and how much is it?' }, CONTEXT);

    expect(result.success).toBe(true);
    expect(loader).toHaveBeenCalledWith(CONTEXT);
    expect(rewriter.histories).toEqual([HISTORY]);
  });

  it('does not load history when the pipeline has no rewriter', async () => {
    const loader = vi.fn(async () => HISTORY);
    const tool = createRAGTool(
      await makePipeline(),
      ['default'],
      {},
      { conversationHistory: loader },
    );

    expect((await tool.execute({ query: 'pricing' }, CONTEXT)).success).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it('searches without history when loading it fails or it is empty', async () => {
    const rewriter = new RecordingRewriter();
    const failing = createRAGTool(
      await makePipeline(rewriter),
      ['default'],
      {},
      {
        conversationHistory: async () => {
          throw new Error('memory down');
        },
      },
    );
    const empty = createRAGTool(
      await makePipeline(rewriter),
      ['default'],
      {},
      {
        conversationHistory: async () => [],
      },
    );

    expect((await failing.execute({ query: 'pricing' }, CONTEXT)).success).toBe(true);
    expect((await empty.execute({ query: 'pricing' }, CONTEXT)).success).toBe(true);
    expect(rewriter.histories).toEqual([undefined, undefined]);
  });

  it('without the option the tool behaves as before', async () => {
    const rewriter = new RecordingRewriter();
    const tool = createRAGTool(await makePipeline(rewriter));

    await tool.execute({ query: 'pricing' }, CONTEXT);

    expect(rewriter.histories).toEqual([undefined]);
  });
});
