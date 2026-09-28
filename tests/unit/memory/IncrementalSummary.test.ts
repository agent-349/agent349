import { describe, it, expect } from 'vitest';
import { IncrementalSummary } from '../../../src/memory/strategies/IncrementalSummary.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../../../src/types/index.js';
import type { LLMMessage } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock LLM Provider
// ─────────────────────────────────────────────────────────────────────────────

function makeLLMResponse(content: string): LLMResponse {
  return {
    content,
    stopReason: 'end',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'mock',
    provider: 'mock',
    latencyMs: 5,
  };
}

class MockProvider extends LLMProvider {
  readonly name = 'mock';
  readonly providerType = 'mock';
  capturedRequest: LLMRequest | null = null;
  callCount = 0;
  private readonly responseContent: string;

  constructor(responseContent = 'Summary of the conversation.') {
    super();
    this.responseContent = responseContent;
  }

  override async call(req: LLMRequest): Promise<LLMResponse> {
    this.capturedRequest = req;
    this.callCount++;
    return makeLLMResponse(this.responseContent);
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMessages(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as LLMMessage['role'],
    content: `message ${i}`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('IncrementalSummary', () => {
  describe('shouldCompress()', () => {
    it('returns false when messages.length <= summaryThreshold', () => {
      const provider = new MockProvider();
      const strategy = new IncrementalSummary(provider, {
        summaryThreshold: 10,
        summaryModel: 'fast-model',
      });
      expect(strategy.shouldCompress(makeMessages(10))).toBe(false);
    });

    it('returns true when messages.length > summaryThreshold', () => {
      const provider = new MockProvider();
      const strategy = new IncrementalSummary(provider, {
        summaryThreshold: 10,
        summaryModel: 'fast-model',
      });
      expect(strategy.shouldCompress(makeMessages(11))).toBe(true);
    });

    it('uses default summaryThreshold of 15', () => {
      const provider = new MockProvider();
      const strategy = new IncrementalSummary(provider, { summaryModel: 'model' });
      expect(strategy.shouldCompress(makeMessages(15))).toBe(false);
      expect(strategy.shouldCompress(makeMessages(16))).toBe(true);
    });
  });

  describe('compress()', () => {
    it('calls the LLM provider once to generate a summary', async () => {
      const provider = new MockProvider('Summarised content.');
      const strategy = new IncrementalSummary(provider, {
        summaryThreshold: 5,
        keepRecent: 3,
        summaryModel: 'haiku',
      });

      await strategy.compress(makeMessages(8));

      expect(provider.callCount).toBe(1);
    });

    it('uses the configured summaryModel for the LLM call', async () => {
      const provider = new MockProvider();
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'claude-haiku-4-5-20251001',
        keepRecent: 2,
      });

      await strategy.compress(makeMessages(10));

      expect(provider.capturedRequest?.model).toBe('claude-haiku-4-5-20251001');
    });

    it('result starts with the summary block', async () => {
      const provider = new MockProvider('The user asked about finance.');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 2,
      });

      const result = await strategy.compress(makeMessages(8));

      expect(result[0]!.role).toBe('user');
      expect(result[0]!.content).toContain('[Conversation Summary]');
      expect(result[0]!.content).toContain('The user asked about finance.');
    });

    it('retains the last keepRecent messages verbatim', async () => {
      const provider = new MockProvider('summary');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 3,
      });
      const messages = makeMessages(8);
      const lastThree = messages.slice(-3);

      const result = await strategy.compress(messages);

      expect(result.slice(-3)).toEqual(lastThree);
    });

    it('total result length is 1 (summary) + keepRecent', async () => {
      const provider = new MockProvider('summary');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 4,
      });

      const result = await strategy.compress(makeMessages(10));

      expect(result).toHaveLength(5); // 1 summary + 4 recent
    });

    it('includes older message content in the LLM call body', async () => {
      const provider = new MockProvider('summary');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 2,
      });
      const messages = makeMessages(5);

      await strategy.compress(messages);

      const userPrompt = provider.capturedRequest!.messages[0]!.content as string;
      expect(userPrompt).toContain('message 0');
      expect(userPrompt).toContain('message 1');
      expect(userPrompt).toContain('message 2');
      // The last 2 (keepRecent) should NOT be in the prompt
      expect(userPrompt).not.toContain('message 3');
      expect(userPrompt).not.toContain('message 4');
    });

    it('does not mutate the input array', async () => {
      const provider = new MockProvider('s');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 2,
      });
      const messages = makeMessages(6);
      const copy = [...messages];

      await strategy.compress(messages);

      expect(messages).toEqual(copy);
    });

    it('returns the messages unchanged when all fit within keepRecent', async () => {
      const provider = new MockProvider('should not be called');
      const strategy = new IncrementalSummary(provider, {
        summaryModel: 'model',
        keepRecent: 10,
      });
      const messages = makeMessages(3);

      const result = await strategy.compress(messages);

      expect(result).toEqual(messages);
      expect(provider.callCount).toBe(0);
    });
  });

  describe('type and accessors', () => {
    it('type is "incremental_summary"', () => {
      const strategy = new IncrementalSummary(new MockProvider(), {
        summaryModel: 'model',
      });
      expect(strategy.type).toBe('incremental_summary');
    });

    it('exposes summaryThreshold', () => {
      const strategy = new IncrementalSummary(new MockProvider(), {
        summaryThreshold: 12,
        summaryModel: 'model',
      });
      expect(strategy.summaryThreshold).toBe(12);
    });

    it('exposes keepRecent', () => {
      const strategy = new IncrementalSummary(new MockProvider(), {
        keepRecent: 7,
        summaryModel: 'model',
      });
      expect(strategy.keepRecent).toBe(7);
    });
  });
});
