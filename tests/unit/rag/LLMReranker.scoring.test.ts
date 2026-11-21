/**
 * LLMReranker scoring: one call for a normal candidate set, parallel batches
 * beyond it, structured output when the provider supports it, a reasoning
 * allowance that grows with the effort, and averaged samples.
 */
import { describe, it, expect, vi } from 'vitest';

import { LLMReranker } from '../../../src/rag/reranker/LLMReranker.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { LLMRequest, LLMResponse } from '../../../src/types/index.js';
import type { Passage } from '../../../src/rag/types.js';

function passages(n: number): Passage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    content: `Content ${i + 1}`,
    score: 0.5,
    collection: 'c',
    metadata: { documentId: `d${i + 1}`, title: `Doc ${i + 1}` },
  }));
}

type Reply = Partial<LLMResponse> | ((req: LLMRequest) => Partial<LLMResponse>);

function makeRouter(reply: Reply, structuredOutput: 'none' | 'jsonSchema' = 'none') {
  const call = vi.fn(async (req: LLMRequest) => ({
    content: '',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...(typeof reply === 'function' ? reply(req) : reply),
  }));
  const router = {
    call,
    getProvider: vi.fn(() => ({ capabilities: () => ({ structuredOutput }) })),
  } as unknown as LLMRouter;
  return { router, call };
}

/** Number of passages listed in a scoring request. */
const listed = (req: LLMRequest): number =>
  ((req.messages[0]!.content as string).match(/^\[\d+\] /gm) ?? []).length;

describe('LLMReranker — scoring', () => {
  it('scores a normal candidate set in a single call', async () => {
    const { router, call } = makeRouter((req) => ({
      content: JSON.stringify(Array.from({ length: listed(req) }, (_, i) => (i === 3 ? 0.9 : 0.1))),
    }));
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });

    const result = await reranker.rerank('q', passages(25), 5);

    expect(call).toHaveBeenCalledTimes(1);
    expect(listed(call.mock.calls[0]![0])).toBe(25);
    expect(result.passages[0]!.id).toBe('p4');
    expect(result.passages[0]!.score).toBe(0.9);
    expect(result.tokensUsed).toBe(15);
  });

  it('splits larger sets into batches scored in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { router, call } = makeRouter(() => ({ content: '' }));
    call.mockImplementation(async (req: LLMRequest) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return {
        content: JSON.stringify(new Array(listed(req)).fill(0.5)),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'm',
      batchSize: 10,
    });

    await reranker.rerank('q', passages(25), 5);

    expect(call.mock.calls.map((c) => listed(c[0]))).toEqual([10, 10, 5]);
    expect(maxInFlight).toBe(3);
  });

  it('requests JSON-Schema output when supported and maps scores by passage id', async () => {
    const { router, call } = makeRouter(
      {
        content: '{"scores":[{"id":2,"score":0.8},{"id":1,"score":0.2},{"id":3,"score":1.4}]}',
        structured: {
          mode: 'native_schema',
          parsed: true,
          value: {
            scores: [
              { id: 2, score: 0.8 },
              { id: 1, score: 0.2 },
              { id: 3, score: 1.4 },
            ],
          },
          validation: 'skipped',
        },
      },
      'jsonSchema',
    );
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });

    const result = await reranker.rerank('q', passages(3), 3);

    const req = call.mock.calls[0]![0];
    expect(req.responseFormat).toMatchObject({
      type: 'json_schema',
      name: 'passage_scores',
      strict: true,
    });
    // Out-of-range scores are clamped; order follows the scores, not the reply order.
    expect(result.passages.map((p) => [p.id, p.score])).toEqual([
      ['p3', 1],
      ['p2', 0.8],
      ['p1', 0.2],
    ]);
  });

  it('parses a structured answer from the text when the provider did not parse it', async () => {
    const { router } = makeRouter(
      { content: '{"scores":[{"id":1,"score":0.3},{"id":2,"score":0.6}]}' },
      'jsonSchema',
    );
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });
    const result = await reranker.rerank('q', passages(2), 2);
    expect(result.passages.map((p) => p.id)).toEqual(['p2', 'p1']);
  });

  it('falls back to a plain JSON array when structured output is off or unsupported', async () => {
    const { router, call } = makeRouter({ content: '[0.1, 0.7]' }, 'jsonSchema');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'm',
      structuredOutput: 'off',
    });
    const result = await reranker.rerank('q', passages(2), 2);
    expect(call.mock.calls[0]![0].responseFormat).toBeUndefined();
    expect(result.passages[0]!.id).toBe('p2');
  });

  it('sizes the completion budget for the reasoning effort', async () => {
    const budget = async (reasoningEffort?: LLMRequest['reasoningEffort']): Promise<number> => {
      const { router, call } = makeRouter({ content: '[0.5, 0.5]' });
      const reranker = new LLMReranker({
        llmRouter: router,
        provider: 'openai',
        model: 'm',
        ...(reasoningEffort !== undefined && { reasoningEffort }),
      });
      await reranker.rerank('q', passages(2), 2);
      return call.mock.calls[0]![0].maxTokens!;
    };
    expect(await budget()).toBe(2 * 16 + 256); // default 'minimal'
    expect(await budget('low')).toBe(2 * 16 + 2048);
    expect(await budget('high')).toBe(2 * 16 + 16384);
  });

  it('averages independent samples', async () => {
    const replies = ['[0.2, 1.0]', '[0.4, 0.6]'];
    let n = 0;
    const { router, call } = makeRouter(() => ({ content: replies[n++ % 2]! }));
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'openai',
      model: 'm',
      samples: 2,
    });

    const result = await reranker.rerank('q', passages(2), 2);

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.passages.map((p) => [p.id, Number(p.score.toFixed(3))])).toEqual([
      ['p2', 0.8],
      ['p1', 0.3],
    ]);
    expect(result.tokensUsed).toBe(30);
  });

  it('scores passages the model left out as 0', async () => {
    const { router } = makeRouter({ content: '{"scores":[{"id":2,"score":0.9}]}' }, 'jsonSchema');
    const reranker = new LLMReranker({ llmRouter: router, provider: 'openai', model: 'm' });
    const result = await reranker.rerank('q', passages(3), 3);
    expect(result.passages.map((p) => [p.id, p.score])).toEqual([
      ['p2', 0.9],
      ['p1', 0],
      ['p3', 0],
    ]);
  });
});
