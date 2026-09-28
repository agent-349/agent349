/**
 * Unit tests for Orchestrator.complete() — the governed single LLM call.
 *
 * Verifies that, unlike a direct router.call(), complete():
 *  - records token usage in the TokenTracker with tenant/user attribution,
 *  - emits llm.call.start / llm.call.end / tokens.recorded (audit plane),
 *  - fills in the estimated cost,
 *  - enforces the daily token limits (RateLimitError) unless disabled,
 *  - emits llm.call.error and rethrows on provider failure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { TokenLimitError, ProviderError } from '../../../src/errors/index.js';
import type {
  LLMRequest,
  LLMResponse,
  ExecutionContext,
  ProviderCapabilities,
} from '../../../src/types/index.js';

function makeResponse(): LLMResponse {
  return {
    content: 'answer',
    stopReason: 'end',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    model: 'mock-model',
    provider: 'mock',
    latencyMs: 5,
  };
}

class MockProvider extends LLMProvider {
  readonly name = 'mock';
  readonly providerType = 'mock';
  public callCount = 0;
  public failNext = false;

  override async call(_req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    if (this.failNext) throw new ProviderError('mock', 'boom', 'mock-model');
    return makeResponse();
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

function makeContext(): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'user-1',
    roles: ['user-1'],
    sessionId: 'sess-1',
    agentId: 'direct',
    requestId: 'req-1',
  };
}

function makeRequest(): LLMRequest {
  return {
    systemPrompt: 'You are a test.',
    messages: [{ role: 'user', content: 'hi' }],
    model: 'mock-model',
  };
}

function todayRange(): { from: Date; to: Date } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

async function makeOrchestrator(perUserDaily = 1_000_000): Promise<{
  orch: Orchestrator;
  provider: MockProvider;
}> {
  const config = ConfigLoader.from({
    tokens: {
      limitMode: 'enforce',
      limits: { perUser: { daily: perUserDaily, monthly: 10_000_000 } },
    },
  }).get();
  const orch = await Orchestrator.fromConfig(config);
  const provider = new MockProvider();
  orch.registerProvider(provider);
  return { orch, provider };
}

async function makeOrchestratorWithMode(
  limitMode: 'enforce' | 'observe' | 'disabled',
  perUserDaily = 1,
): Promise<{ orch: Orchestrator; provider: MockProvider }> {
  const config = ConfigLoader.from({
    tokens: {
      limitMode,
      limits: { perUser: { daily: perUserDaily, monthly: 10_000_000 } },
    },
  }).get();
  const orch = await Orchestrator.fromConfig(config);
  const provider = new MockProvider();
  orch.registerProvider(provider);
  return { orch, provider };
}

describe('Orchestrator.complete()', () => {
  let events: Array<{ type: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    events = [];
  });

  it('returns the provider response and records tokens for the tenant/user', async () => {
    const { orch, provider } = await makeOrchestrator();
    const resp = await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });

    expect(resp.content).toBe('answer');
    expect(provider.callCount).toBe(1);

    const byUser = await orch.tokens.getByUser('acme', 'user-1', todayRange());
    expect(byUser.totalInputTokens).toBe(20);
    expect(byUser.totalOutputTokens).toBe(10);
  });

  it('fills in the estimated cost when the provider does not report one', async () => {
    const { orch } = await makeOrchestrator();
    const resp = await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });
    // mock-model is not in the pricing table → estimated cost 0, but defined.
    expect(resp.usage.cost).toBeDefined();
  });

  it('emits llm.call.start/end and tokens.recorded with _context attribution', async () => {
    const { orch } = await makeOrchestrator();
    for (const type of ['llm.call.start', 'llm.call.end', 'tokens.recorded']) {
      orch.events.on(type, (event) => {
        events.push({ type, data: event.data as Record<string, unknown> });
      });
    }

    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });

    expect(events.map((e) => e.type)).toEqual([
      'llm.call.start',
      'llm.call.end',
      'tokens.recorded',
    ]);
    for (const e of events) {
      const ctx = e.data['_context'] as Record<string, unknown>;
      expect(ctx['tenantId']).toBe('acme');
      expect(ctx['userId']).toBe('user-1');
    }
  });

  it('enforces the per-user daily token limit', async () => {
    // First call consumes 30 tokens; limit 40 → second call must be rejected.
    const { orch, provider } = await makeOrchestrator(40);
    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });
    // Second call would leave 10 remaining (>0)… consume again to exhaust.
    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });
    await expect(orch.complete(makeRequest(), makeContext(), { provider: 'mock' })).rejects.toThrow(
      TokenLimitError,
    );
    expect(provider.callCount).toBe(2);
  });

  it('skips the limit check when enforceLimits is false', async () => {
    const { orch, provider } = await makeOrchestrator(40);
    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });
    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });
    await orch.complete(makeRequest(), makeContext(), {
      provider: 'mock',
      enforceLimits: false,
    });
    expect(provider.callCount).toBe(3);
  });

  it('observe emits a violation event but still calls and records the provider', async () => {
    const { orch, provider } = await makeOrchestratorWithMode('observe');
    const observed: unknown[] = [];
    orch.events.on('tokens.limit.observed', (event) => observed.push(event.data));

    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });

    expect(provider.callCount).toBe(1);
    expect(observed).toHaveLength(1);
    expect((await orch.tokens.getByUser('acme', 'user-1', todayRange())).recordCount).toBe(1);
  });

  it('disabled calls the provider without storing usage', async () => {
    const { orch, provider } = await makeOrchestratorWithMode('disabled');

    await orch.complete(makeRequest(), makeContext(), { provider: 'mock' });

    expect(provider.callCount).toBe(1);
    expect((await orch.tokens.getByUser('acme', 'user-1', todayRange())).recordCount).toBe(0);
  });

  it('emits llm.call.error and rethrows when the provider fails', async () => {
    const { orch, provider } = await makeOrchestrator();
    provider.failNext = true;
    orch.events.on('llm.call.error', (event) => {
      events.push({ type: 'llm.call.error', data: event.data as Record<string, unknown> });
    });

    await expect(orch.complete(makeRequest(), makeContext(), { provider: 'mock' })).rejects.toThrow(
      ProviderError,
    );
    expect(events).toHaveLength(1);

    // Nothing was recorded for the failed call.
    const byUser = await orch.tokens.getByUser('acme', 'user-1', todayRange());
    expect(byUser.totalInputTokens).toBe(0);
  });
});
