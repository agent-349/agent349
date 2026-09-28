/**
 * Unit tests for ContextualRewriter and HyDERewriter.
 * LLMRouter calls are mocked with vi.fn().
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextualRewriter } from '../../../src/rag/queryRewriting/ContextualRewriter.js';
import { HyDERewriter } from '../../../src/rag/queryRewriting/HyDERewriter.js';
import type { LLMRouter } from '../../../src/llm/LLMRouter.js';
import type { LLMMessage } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRouter(responseContent: string): LLMRouter {
  return {
    call: vi.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  } as unknown as LLMRouter;
}

const history: LLMMessage[] = [
  { role: 'user', content: 'Tell me about Plan A' },
  { role: 'assistant', content: 'Plan A costs $50/month and includes unlimited storage.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// ContextualRewriter
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextualRewriter', () => {
  it('returns original query when no conversation history is provided', async () => {
    const router = makeRouter('rewritten query');
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('How much does it cost?');

    expect(result).toBe('How much does it cost?');
    expect(router.call).not.toHaveBeenCalled();
  });

  it('returns original query when conversation history is empty', async () => {
    const router = makeRouter('rewritten query');
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('How much does it cost?', []);

    expect(result).toBe('How much does it cost?');
    expect(router.call).not.toHaveBeenCalled();
  });

  it('calls the LLM router and returns the rewritten query', async () => {
    const router = makeRouter('What is the price of Plan A?');
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('And the price?', history);

    expect(result).toBe('What is the price of Plan A?');
    expect(router.call).toHaveBeenCalledOnce();
  });

  it('falls back to original query when LLM returns empty string', async () => {
    const router = makeRouter('');
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('What about refunds?', history);

    expect(result).toBe('What about refunds?');
  });

  it('falls back to original query when LLM response is too long (> 500 chars)', async () => {
    const router = makeRouter('x'.repeat(501));
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('query', history);

    expect(result).toBe('query');
  });

  it('falls back to original query when LLM call throws', async () => {
    const router = {
      call: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as LLMRouter;
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('query', history);

    expect(result).toBe('query');
  });

  it('only includes the most recent historyWindow messages', async () => {
    const longHistory: LLMMessage[] = Array.from(
      { length: 20 },
      (_, i) =>
        ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i}`,
        }) as LLMMessage,
    );

    const router = makeRouter('rewritten');
    const rewriter = new ContextualRewriter(router, 'mock', 'mock-model', 4);

    await rewriter.rewrite('latest query', longHistory);

    const [req] = (router.call as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { messages: Array<{ content: string }> },
    ];
    // The user content should reference only the last 4 messages
    expect(req.messages[0]!.content).toContain('message 16');
    expect(req.messages[0]!.content).not.toContain('message 0');
  });

  it('has name "contextual"', () => {
    const rewriter = new ContextualRewriter({} as LLMRouter, 'p', 'm');
    expect(rewriter.name).toBe('contextual');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HyDERewriter
// ─────────────────────────────────────────────────────────────────────────────

describe('HyDERewriter', () => {
  it('calls the LLM router and returns the hypothetical document', async () => {
    const hypothetical = 'Employees are entitled to 15 business days of paid vacation per year.';
    const router = makeRouter(hypothetical);
    const rewriter = new HyDERewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('vacation days policy');

    expect(result).toBe(hypothetical);
    expect(router.call).toHaveBeenCalledOnce();
  });

  it('falls back to original query when LLM output is too short (< 20 chars)', async () => {
    const router = makeRouter('yes');
    const rewriter = new HyDERewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('vacation days policy');

    expect(result).toBe('vacation days policy');
  });

  it('falls back to original query when LLM call throws', async () => {
    const router = {
      call: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as LLMRouter;
    const rewriter = new HyDERewriter(router, 'mock', 'mock-model');

    const result = await rewriter.rewrite('query');

    expect(result).toBe('query');
  });

  it('ignores conversation history (HyDE does not use it)', async () => {
    const router = makeRouter('A hypothetical document with enough content to pass the threshold.');
    const rewriter = new HyDERewriter(router, 'mock', 'mock-model');

    await rewriter.rewrite('query', history);

    const [req] = (router.call as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { messages: Array<{ content: string }> },
    ];
    // Message should only contain the raw query, not conversation history
    expect(req.messages[0]!.content).toBe('query');
  });

  it('has name "hyde"', () => {
    const rewriter = new HyDERewriter({} as LLMRouter, 'p', 'm');
    expect(rewriter.name).toBe('hyde');
  });
});
