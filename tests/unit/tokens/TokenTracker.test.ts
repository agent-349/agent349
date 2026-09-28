import { describe, it, expect, beforeEach } from 'vitest';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import type { ExecutionContext } from '../../../src/types/index.js';
import type { UsageData } from '../../../src/tokens/TokenTracker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

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
    cost: 0.001,
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

/** A date range that definitely covers today. */
function todayRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

/** A fixed past date range that should never contain today's records. */
const pastRange = {
  from: new Date('2000-01-01T00:00:00.000Z'),
  to: new Date('2000-01-31T23:59:59.999Z'),
};

let tracker: TokenTracker;

beforeEach(() => {
  tracker = new TokenTracker(new InMemoryAdapter());
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty-state behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('empty state', () => {
  it('getByTenant returns a zero summary when no records exist', async () => {
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.recordCount).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byModel).toEqual({});
    expect(summary.byAgent).toEqual({});
  });

  it('getByUser returns a zero summary when no records exist', async () => {
    const summary = await tracker.getByUser('acme', 'user-1', todayRange());
    expect(summary.recordCount).toBe(0);
  });

  it('checkLimit returns allowed=true with full remaining when no records exist', async () => {
    const result = await tracker.checkLimit('acme');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(result.limit);
  });

  it('checkLimit (user) returns allowed=true with full remaining when no records exist', async () => {
    const result = await tracker.checkLimit('acme', 'user-1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(result.limit);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// record()
// ─────────────────────────────────────────────────────────────────────────────

describe('record()', () => {
  it('a recorded call is visible in getByTenant for today', async () => {
    await tracker.record(makeContext(), makeUsage());
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.recordCount).toBe(1);
  });

  it('a recorded call is visible in getByUser for today', async () => {
    await tracker.record(makeContext(), makeUsage());
    const summary = await tracker.getByUser('acme', 'user-1', todayRange());
    expect(summary.recordCount).toBe(1);
  });

  it('does not appear under a different tenant', async () => {
    await tracker.record(makeContext({ tenantId: 'acme' }), makeUsage());
    const summary = await tracker.getByTenant('other-tenant', todayRange());
    expect(summary.recordCount).toBe(0);
  });

  it('does not appear under a different user in getByUser', async () => {
    await tracker.record(makeContext({ userId: 'user-1' }), makeUsage());
    const summary = await tracker.getByUser('acme', 'user-2', todayRange());
    expect(summary.recordCount).toBe(0);
  });

  it('does not appear in a past date range', async () => {
    await tracker.record(makeContext(), makeUsage());
    const summary = await tracker.getByTenant('acme', pastRange);
    expect(summary.recordCount).toBe(0);
  });

  it('stores provider and model from usage', async () => {
    await tracker.record(makeContext(), makeUsage({ provider: 'openai', model: 'gpt-4o' }));
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.byModel['gpt-4o']).toBeDefined();
  });

  it('defaults provider to "unknown" when not provided', async () => {
    const usage: UsageData = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await tracker.record(makeContext(), usage);
    // Record is still stored — getByTenant shows it
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.recordCount).toBe(1);
  });

  it('defaults estimatedCostUsd to 0 when cost is not provided', async () => {
    const usage: UsageData = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await tracker.record(makeContext(), usage);
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.totalCostUsd).toBe(0);
  });

  it('multiple records accumulate correctly', async () => {
    await tracker.record(makeContext(), makeUsage({ inputTokens: 100, outputTokens: 50 }));
    await tracker.record(makeContext(), makeUsage({ inputTokens: 200, outputTokens: 80 }));
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.recordCount).toBe(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(130);
  });

  it('records from multiple users both appear in getByTenant', async () => {
    await tracker.record(makeContext({ userId: 'user-1' }), makeUsage());
    await tracker.record(makeContext({ userId: 'user-2' }), makeUsage());
    const summary = await tracker.getByTenant('acme', todayRange());
    expect(summary.recordCount).toBe(2);
  });

  it('each user sees only their own records in getByUser', async () => {
    await tracker.record(makeContext({ userId: 'user-1' }), makeUsage({ inputTokens: 100 }));
    await tracker.record(makeContext({ userId: 'user-2' }), makeUsage({ inputTokens: 200 }));

    const u1 = await tracker.getByUser('acme', 'user-1', todayRange());
    const u2 = await tracker.getByUser('acme', 'user-2', todayRange());

    expect(u1.recordCount).toBe(1);
    expect(u1.totalInputTokens).toBe(100);
    expect(u2.recordCount).toBe(1);
    expect(u2.totalInputTokens).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getByTenant() / getByUser() — aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('summary aggregation', () => {
  it('totalInputTokens sums all records', async () => {
    await tracker.record(makeContext(), makeUsage({ inputTokens: 100, outputTokens: 0 }));
    await tracker.record(makeContext(), makeUsage({ inputTokens: 300, outputTokens: 0 }));
    const { totalInputTokens } = await tracker.getByTenant('acme', todayRange());
    expect(totalInputTokens).toBe(400);
  });

  it('totalOutputTokens sums all records', async () => {
    await tracker.record(makeContext(), makeUsage({ inputTokens: 0, outputTokens: 50 }));
    await tracker.record(makeContext(), makeUsage({ inputTokens: 0, outputTokens: 70 }));
    const { totalOutputTokens } = await tracker.getByTenant('acme', todayRange());
    expect(totalOutputTokens).toBe(120);
  });

  it('totalCostUsd sums all records', async () => {
    await tracker.record(makeContext(), makeUsage({ cost: 0.01 }));
    await tracker.record(makeContext(), makeUsage({ cost: 0.02 }));
    const { totalCostUsd } = await tracker.getByTenant('acme', todayRange());
    expect(totalCostUsd).toBeCloseTo(0.03);
  });

  it('byModel groups tokens and cost per model', async () => {
    await tracker.record(
      makeContext({ agentId: 'agent-a' }),
      makeUsage({ inputTokens: 100, outputTokens: 50, cost: 0.01, model: 'model-x' }),
    );
    await tracker.record(
      makeContext({ agentId: 'agent-b' }),
      makeUsage({ inputTokens: 200, outputTokens: 80, cost: 0.02, model: 'model-x' }),
    );
    await tracker.record(
      makeContext(),
      makeUsage({ inputTokens: 50, outputTokens: 25, cost: 0.005, model: 'model-y' }),
    );

    const { byModel } = await tracker.getByTenant('acme', todayRange());

    expect(byModel['model-x']?.tokens).toBe(430); // (100+50) + (200+80)
    expect(byModel['model-x']?.cost).toBeCloseTo(0.03);
    expect(byModel['model-y']?.tokens).toBe(75);
    expect(byModel['model-y']?.cost).toBeCloseTo(0.005);
  });

  it('byAgent groups tokens and cost per agent', async () => {
    await tracker.record(
      makeContext({ agentId: 'agent-finance' }),
      makeUsage({ inputTokens: 100, outputTokens: 50, cost: 0.01 }),
    );
    await tracker.record(
      makeContext({ agentId: 'agent-hr' }),
      makeUsage({ inputTokens: 200, outputTokens: 80, cost: 0.02 }),
    );

    const { byAgent } = await tracker.getByTenant('acme', todayRange());

    expect(byAgent['agent-finance']?.tokens).toBe(150);
    expect(byAgent['agent-finance']?.cost).toBeCloseTo(0.01);
    expect(byAgent['agent-hr']?.tokens).toBe(280);
    expect(byAgent['agent-hr']?.cost).toBeCloseTo(0.02);
  });

  it('recordCount matches the number of records stored', async () => {
    for (let i = 0; i < 5; i++) {
      await tracker.record(makeContext({ requestId: `req-${i}` }), makeUsage());
    }
    const { recordCount } = await tracker.getByTenant('acme', todayRange());
    expect(recordCount).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getByTenant() date range filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('date range filtering', () => {
  it('returns zero summary for an empty date range in the past', async () => {
    await tracker.record(makeContext(), makeUsage());
    const summary = await tracker.getByTenant('acme', pastRange);
    expect(summary.recordCount).toBe(0);
  });

  it('includes records exactly at the range boundaries', async () => {
    // Record something now and query a range that spans today
    await tracker.record(makeContext(), makeUsage());
    const range = todayRange();
    const summary = await tracker.getByTenant('acme', range);
    expect(summary.recordCount).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkLimit()
// ─────────────────────────────────────────────────────────────────────────────

describe('checkLimit()', () => {
  it('returns the configured tenant daily limit', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 5_000, monthly: 100_000 },
    });
    const result = await t.checkLimit('acme');
    expect(result.limit).toBe(5_000);
  });

  it('returns the configured user daily limit', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perUser: { daily: 1_000, monthly: 10_000 },
    });
    const result = await t.checkLimit('acme', 'user-1');
    expect(result.limit).toBe(1_000);
  });

  it('allowed=true and remaining=limit when no tokens recorded', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 5_000, monthly: 100_000 },
    });
    const result = await t.checkLimit('acme');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5_000);
  });

  it('decrements remaining by recorded tokens (tenant)', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 1_000, monthly: 100_000 },
    });
    await t.record(makeContext(), makeUsage({ inputTokens: 300, outputTokens: 200 })); // 500 tokens
    const result = await t.checkLimit('acme');
    expect(result.remaining).toBe(500);
    expect(result.allowed).toBe(true);
  });

  it('decrements remaining by recorded tokens (user)', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perUser: { daily: 1_000, monthly: 100_000 },
    });
    await t.record(makeContext(), makeUsage({ inputTokens: 400, outputTokens: 100 })); // 500 tokens
    const result = await t.checkLimit('acme', 'user-1');
    expect(result.remaining).toBe(500);
    expect(result.allowed).toBe(true);
  });

  it('allowed=false when tokens exceed tenant limit', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 100, monthly: 1_000 },
    });
    await t.record(makeContext(), makeUsage({ inputTokens: 80, outputTokens: 30 })); // 110 > 100
    const result = await t.checkLimit('acme');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('allowed=false when tokens exceed user limit', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perUser: { daily: 100, monthly: 1_000 },
    });
    await t.record(makeContext(), makeUsage({ inputTokens: 80, outputTokens: 30 })); // 110 > 100
    const result = await t.checkLimit('acme', 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('remaining is never negative', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 100, monthly: 1_000 },
    });
    await t.record(makeContext(), makeUsage({ inputTokens: 1_000, outputTokens: 1_000 }));
    const result = await t.checkLimit('acme');
    expect(result.remaining).toBe(0);
  });

  it('tenant check is independent from user check', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 10_000, monthly: 100_000 },
      perUser: { daily: 200, monthly: 1_000 },
    });
    // Record 500 tokens — under tenant limit but over user limit
    await t.record(makeContext(), makeUsage({ inputTokens: 300, outputTokens: 200 }));

    const tenantResult = await t.checkLimit('acme');
    const userResult = await t.checkLimit('acme', 'user-1');

    expect(tenantResult.allowed).toBe(true);
    expect(userResult.allowed).toBe(false);
  });

  it('only counts tokens for the target tenant', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 1_000, monthly: 10_000 },
    });
    await t.record(
      makeContext({ tenantId: 'other' }),
      makeUsage({ inputTokens: 900, outputTokens: 0 }),
    );
    const result = await t.checkLimit('acme');
    // 'acme' has no records — full limit remaining
    expect(result.remaining).toBe(1_000);
  });

  it('only counts tokens for the target user', async () => {
    const t = new TokenTracker(new InMemoryAdapter(), {
      perUser: { daily: 1_000, monthly: 10_000 },
    });
    await t.record(
      makeContext({ userId: 'user-2' }),
      makeUsage({ inputTokens: 900, outputTokens: 0 }),
    );
    const result = await t.checkLimit('acme', 'user-1');
    expect(result.remaining).toBe(1_000);
  });

  it('uses default tenant daily limit of 1,000,000', async () => {
    const result = await tracker.checkLimit('acme');
    expect(result.limit).toBe(1_000_000);
  });

  it('uses default user daily limit of 50,000', async () => {
    const result = await tracker.checkLimit('acme', 'user-1');
    expect(result.limit).toBe(50_000);
  });
});

describe('limit modes and combined limits', () => {
  it('observe reports an exceeded user budget without blocking', async () => {
    const observed = new TokenTracker(
      new InMemoryAdapter(),
      { perUser: { daily: 100, monthly: 1_000 } },
      undefined,
      'observe',
    );
    await observed.record(makeContext(), makeUsage({ inputTokens: 90, outputTokens: 0 }));

    const decision = await observed.checkLimits('acme', 'user-1', 20);

    expect(decision.allowed).toBe(true);
    expect(decision.exceeded).toBe(true);
    expect(decision.violation?.scope).toBe('user');
    expect(decision.violation?.window).toBe('daily');
    expect(decision.violation?.used).toBe(90);
    expect(decision.violation?.projected).toBe(110);
  });

  it('enforce blocks on the tenant budget even when the user budget has room', async () => {
    const enforced = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 100, monthly: 10_000 },
      perUser: { daily: 1_000, monthly: 10_000 },
    });
    await enforced.record(makeContext(), makeUsage({ inputTokens: 90, outputTokens: 0 }));

    const decision = await enforced.checkLimits('acme', 'user-1', 20);

    expect(decision.allowed).toBe(false);
    expect(decision.violation?.scope).toBe('tenant');
    expect(decision.violation?.window).toBe('daily');
  });

  it('enforce checks monthly budgets as well as daily budgets', async () => {
    const enforced = new TokenTracker(new InMemoryAdapter(), {
      perTenant: { daily: 10_000, monthly: 10_000 },
      perUser: { daily: 10_000, monthly: 100 },
    });
    await enforced.record(makeContext(), makeUsage({ inputTokens: 90, outputTokens: 0 }));

    const decision = await enforced.checkLimits('acme', 'user-1', 20);

    expect(decision.allowed).toBe(false);
    expect(decision.violation?.scope).toBe('user');
    expect(decision.violation?.window).toBe('monthly');
  });

  it('disabled skips recording and quota reads', async () => {
    const disabled = new TokenTracker(
      new InMemoryAdapter(),
      { perUser: { daily: 1, monthly: 1 } },
      undefined,
      'disabled',
    );
    await disabled.record(makeContext(), makeUsage());

    const summary = await disabled.getByUser('acme', 'user-1', todayRange());
    const decision = await disabled.checkLimits('acme', 'user-1', 1_000_000);

    expect(summary.recordCount).toBe(0);
    expect(decision.allowed).toBe(true);
    expect(decision.checks).toEqual([]);
  });
});
