/**
 * Tests for LLMReranker parse error handling.
 *
 * An unparseable LLM response used to be papered over with synthetic descending
 * scores. Those scores are indistinguishable from a real ranking downstream —
 * plausibly ordered, above any `minScore`, reported as `reranked: true` — so the
 * default is now to raise a RerankerError. The old behaviour survives only under
 * an explicit `onParseFailure: 'degrade'`.
 */
import { describe, it, expect, vi } from 'vitest';

import { LLMReranker } from '../../../src/rag/reranker/LLMReranker.js';
import { RerankerError } from '../../../src/errors/RerankerError.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { Passage } from '../../../src/rag/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePassage(id: string, score = 0.5): Passage {
  return {
    id,
    content: `Content of ${id}`,
    score,
    collection: 'test',
    metadata: { documentId: id },
  };
}

function makeMockRouter(responseContent: string): LLMRouter {
  return {
    call: vi.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    getProvider: vi.fn(),
    register: vi.fn(),
  } as unknown as LLMRouter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default policy: throw
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMReranker — parse error, default policy', () => {
  it('throws RerankerError when the LLM returns invalid JSON', async () => {
    const router = makeMockRouter('Sorry, I cannot score these passages.');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
    });

    await expect(
      reranker.rerank('query', [makePassage('p1'), makePassage('p2')], 2),
    ).rejects.toBeInstanceOf(RerankerError);
  });

  it('reports the parse stage and the RERANKER_UNAVAILABLE code', async () => {
    const router = makeMockRouter('{"not": "an array"}');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
    });

    await expect(reranker.rerank('query', [makePassage('p1')], 1)).rejects.toMatchObject({
      code: 'RERANKER_UNAVAILABLE',
      stage: 'parse',
      provider: 'llm',
    });
  });

  it('throws with no EventBus configured (the event is optional, the failure is not)', async () => {
    const router = makeMockRouter('invalid');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
      // No eventBus
    });

    await expect(reranker.rerank('query', [makePassage('p1')], 1)).rejects.toBeInstanceOf(
      RerankerError,
    );
  });

  it('emits rag.rerank.parse_error before throwing', async () => {
    const router = makeMockRouter('{"not": "an array"}');
    const bus = new EventBus();
    const emitSpy = vi.spyOn(bus, 'emit');

    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
      eventBus: bus,
    });

    await expect(
      reranker.rerank('query', [makePassage('p1'), makePassage('p2')], 2),
    ).rejects.toBeInstanceOf(RerankerError);

    expect(emitSpy).toHaveBeenCalledWith(
      'rag.rerank.parse_error',
      expect.objectContaining({
        model: 'mock-model',
        expectedLength: 2,
        onParseFailure: 'throw',
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in policy: degrade
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMReranker — parse error, onParseFailure: degrade', () => {
  it('preserves original passage order when the LLM returns invalid JSON', async () => {
    const router = makeMockRouter('Sorry, I cannot score these passages.');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
      onParseFailure: 'degrade',
    });

    const passages = [makePassage('p1'), makePassage('p2'), makePassage('p3')];
    const result = await reranker.rerank('query', passages, 3);

    // Scores should be descending (original order preserved), not all zeros.
    expect(result.passages[0]!.score).toBeGreaterThan(result.passages[1]!.score);
    expect(result.passages[1]!.score).toBeGreaterThan(result.passages[2]!.score);
    // The first passage in the fallback should be the first in the input.
    expect(result.passages[0]!.id).toBe('p1');
  });

  it('does not return all-zero scores on parse failure', async () => {
    const router = makeMockRouter('not valid json at all');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
      onParseFailure: 'degrade',
    });

    const result = await reranker.rerank('query', [makePassage('p1'), makePassage('p2')], 2);

    for (const p of result.passages) {
      expect(p.score).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path (policy-independent)
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMReranker — valid response', () => {
  it('returns correct scores when the LLM response is valid JSON', async () => {
    const router = makeMockRouter('[0.9, 0.1, 0.5]');
    const reranker = new LLMReranker({
      llmRouter: router,
      provider: 'mock',
      model: 'mock-model',
    });

    const passages = [makePassage('p1'), makePassage('p2'), makePassage('p3')];
    const result = await reranker.rerank('query', passages, 3);

    // p1 has score 0.9, p3 has 0.5, p2 has 0.1 — sorted descending.
    expect(result.passages[0]!.id).toBe('p1');
    expect(result.passages[0]!.score).toBeCloseTo(0.9);
    expect(result.passages[1]!.id).toBe('p3');
    expect(result.passages[2]!.id).toBe('p2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring text
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMReranker — scoring text', () => {
  it('includes the title in the scoring prompt without altering the passage', async () => {
    const router = makeMockRouter('[0.9]');
    const reranker = new LLMReranker({ llmRouter: router, provider: 'mock', model: 'mock-model' });

    const p: Passage = {
      id: 'p1',
      content: 'chunk body',
      score: 0,
      collection: 'test',
      metadata: { documentId: 'p1', title: 'Circular 21.0070.pdf' },
    };
    const res = await reranker.rerank('q', [p], 1);

    const call = (router.call as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0]!.content).toContain('Circular 21.0070.pdf');
    expect(call.messages[0]!.content).toContain('chunk body');
    expect(res.passages[0]!.content).toBe('chunk body');
  });
});
