import { describe, it, expect, beforeEach } from 'vitest';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { PricingTable } from '../../../src/tokens/PricingTable.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import type { ExecutionContext } from '../../../src/types/index.js';
import type { UsageData } from '../../../src/tokens/TokenTracker.js';

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'user-1',
    agentId: 'agent-finance',
    sessionId: 'sess-1',
    requestId: 'req-1',
    roles: ['viewer'],
    ...overrides,
  };
}

function makeUsage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

function todayRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

let tracker: TokenTracker;

beforeEach(() => {
  tracker = new TokenTracker(
    new InMemoryAdapter(),
    {},
    new PricingTable({
      'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
    }),
  );
});

describe('TokenTracker — pricing fallback', () => {
  it('estimateCost uses the configured price list', () => {
    expect(tracker.estimateCost('claude-sonnet-4-20250514', 1000, 1000)).toBeCloseTo(0.018, 6);
    expect(tracker.estimateCost('unknown', 1000, 1000)).toBe(0);
  });

  it('computes estimatedCostUsd from pricing when usage.cost is absent', async () => {
    await tracker.record(makeContext(), makeUsage()); // no cost provided
    const summary = await tracker.getByRequest('req-1');
    // 100 in * 0.003/1000 + 50 out * 0.015/1000 = 0.0003 + 0.00075 = 0.00105
    expect(summary.totalCostUsd).toBeCloseTo(0.00105, 6);
  });

  it('prefers a provider-reported cost over the price list', async () => {
    await tracker.record(makeContext(), makeUsage({ cost: 0.5 }));
    const summary = await tracker.getByRequest('req-1');
    expect(summary.totalCostUsd).toBe(0.5);
  });
});

describe('TokenTracker — multi-dimension queries', () => {
  it('getByAgent aggregates a single agent', async () => {
    await tracker.record(makeContext({ agentId: 'a1' }), makeUsage());
    await tracker.record(makeContext({ agentId: 'a2' }), makeUsage());
    const summary = await tracker.getByAgent('acme', 'a1', todayRange());
    expect(summary.recordCount).toBe(1);
    expect(summary.byAgent['a1']!.tokens).toBe(150);
  });

  it('getBySession aggregates all calls in a conversation', async () => {
    await tracker.record(makeContext({ sessionId: 's9' }), makeUsage());
    await tracker.record(
      makeContext({ sessionId: 's9' }),
      makeUsage({ inputTokens: 10, outputTokens: 5 }),
    );
    const summary = await tracker.getBySession('s9');
    expect(summary.recordCount).toBe(2);
    expect(summary.totalInputTokens).toBe(110);
    expect(summary.totalOutputTokens).toBe(55);
  });

  it('getByRequest sums every call of one request, including tool-attributed ones', async () => {
    const ctx = makeContext({ requestId: 'r-multi' });
    await tracker.record(ctx, makeUsage()); // agent reasoning
    await tracker.record(
      ctx,
      makeUsage({ toolName: 'rag.search', model: 'reranker', provider: 'cohere' }),
    );
    const summary = await tracker.getByRequest('r-multi');
    expect(summary.recordCount).toBe(2);
    expect(summary.byTool['rag.search']!.tokens).toBe(150);
  });
});

describe('TokenTracker — breakdowns', () => {
  it('builds byProvider / byModel / bySkill / byTool', async () => {
    const ctx = makeContext({ requestId: 'r-bd' });
    await tracker.record(
      ctx,
      makeUsage({ provider: 'claude', model: 'claude-sonnet-4-20250514', skillId: 'finance' }),
    );
    await tracker.record(
      ctx,
      makeUsage({ provider: 'cohere', model: 'reranker', toolName: 'rag.search' }),
    );

    const s = await tracker.getByRequest('r-bd');
    expect(Object.keys(s.byProvider).sort()).toEqual(['claude', 'cohere']);
    expect(Object.keys(s.byModel).sort()).toEqual(['claude-sonnet-4-20250514', 'reranker']);
    expect(s.bySkill['finance']!.tokens).toBe(150);
    expect(s.byTool['rag.search']!.tokens).toBe(150);
  });

  it('omits unattributed records from bySkill/byTool', async () => {
    await tracker.record(makeContext({ requestId: 'r-plain' }), makeUsage()); // no skill/tool
    const s = await tracker.getByRequest('r-plain');
    expect(s.bySkill).toEqual({});
    expect(s.byTool).toEqual({});
    expect(s.byProvider['claude']!.tokens).toBe(150);
  });
});
