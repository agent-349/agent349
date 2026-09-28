import { describe, it, expect, beforeEach } from 'vitest';
import { Observability } from '../../../src/observability/Observability.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { AuditLogger } from '../../../src/audit/AuditLogger.js';
import { InMemoryAuditStore } from '../../../src/audit/store/InMemoryAuditStore.js';
import type { ExecutionContext } from '../../../src/types/index.js';

function makeContext(): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'u1',
    agentId: 'a1',
    sessionId: 's1',
    requestId: 'r1',
    roles: [],
  };
}

let bus: EventBus;
let tokens: TokenTracker;

beforeEach(() => {
  bus = new EventBus();
  tokens = new TokenTracker(new InMemoryAdapter());
});

describe('Observability', () => {
  it('exposes the three planes', () => {
    const obs = new Observability({ events: bus, tokens });
    expect(obs.events).toBe(bus);
    expect(obs.tokens).toBe(tokens);
    expect(obs.audit).toBeUndefined();
  });

  it('getRequestReport returns usage even without audit', async () => {
    await tokens.record(makeContext(), {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
    });

    const obs = new Observability({ events: bus, tokens });
    const report = await obs.getRequestReport('r1');
    expect(report.requestId).toBe('r1');
    expect(report.usage.totalCostUsd).toBe(0.01);
    expect(report.auditTrail).toEqual([]);
  });

  it('getRequestReport combines usage and the audit trail', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditLogger(store, bus, {});
    await tokens.record(makeContext(), {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cost: 0.002,
      provider: 'claude',
      model: 'm',
    });
    await audit.log({ requestId: 'r1', tenantId: 'acme', category: 'agent', action: 'loop_end' });
    await audit.flush();

    const obs = new Observability({ events: bus, tokens, audit });
    const report = await obs.getRequestReport('r1');
    expect(report.usage.totalCostUsd).toBe(0.002);
    expect(report.auditTrail).toHaveLength(1);
    expect(report.auditTrail[0]!.action).toBe('loop_end');
  });

  it('flush() returns 0 when audit is disabled', async () => {
    const obs = new Observability({ events: bus, tokens });
    expect(await obs.flush()).toBe(0);
  });
});
