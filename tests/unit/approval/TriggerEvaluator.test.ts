import { describe, it, expect } from 'vitest';
import { TriggerEvaluator } from '../../../src/approval/TriggerEvaluator.js';
import type { ApprovalTrigger, ExecutionContext } from '../../../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTrigger(overrides: Partial<ApprovalTrigger> = {}): ApprovalTrigger {
  return {
    id: 'trigger-1',
    name: 'Test Trigger',
    description: 'Requires approval',
    enabled: true,
    scope: { all: true },
    conditions: [{ type: 'always' }],
    approvalConfig: {
      risk: 'high',
      approverRoles: ['manager'],
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    roles: ['employee'],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TriggerEvaluator', () => {
  const evaluator = new TriggerEvaluator();

  // ─── Disabled trigger ─────────────────────────────────────────────────────

  it('returns null for disabled trigger', () => {
    const trigger = makeTrigger({ enabled: false });
    const result = evaluator.evaluate([trigger], 'some.tool', {}, makeContext());
    expect(result).toBeNull();
  });

  // ─── Scope: all ───────────────────────────────────────────────────────────

  it('matches scope.all=true for any tool', () => {
    const trigger = makeTrigger({ scope: { all: true } });
    const result = evaluator.evaluate([trigger], 'any.tool.name', {}, makeContext());
    expect(result).not.toBeNull();
    expect(result!.triggerId).toBe('trigger-1');
  });

  // ─── Scope: tools (exact) ─────────────────────────────────────────────────

  it('matches scope.tools for exact tool name', () => {
    const trigger = makeTrigger({ scope: { tools: ['finance.transfer'] } });
    expect(evaluator.evaluate([trigger], 'finance.transfer', {}, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'finance.other', {}, makeContext())).toBeNull();
  });

  // ─── Scope: skills (prefix) ───────────────────────────────────────────────

  it('matches scope.skills by prefix and exact name', () => {
    const trigger = makeTrigger({ scope: { skills: ['hr'] } });
    expect(evaluator.evaluate([trigger], 'hr.getEmployee', {}, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'hr', {}, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'finance.transfer', {}, makeContext())).toBeNull();
  });

  // ─── Scope: tags ──────────────────────────────────────────────────────────

  it('skips tags scope when no registry provided', () => {
    const trigger = makeTrigger({ scope: { tags: ['sensitive'] } });
    expect(evaluator.evaluate([trigger], 'any.tool', {}, makeContext())).toBeNull();
  });

  // ─── Condition: always ────────────────────────────────────────────────────

  it('condition always returns match', () => {
    const trigger = makeTrigger({ conditions: [{ type: 'always' }] });
    expect(evaluator.evaluate([trigger], 'tool', {}, makeContext())).not.toBeNull();
  });

  // ─── Condition: input_field ───────────────────────────────────────────────

  it('input_field gt operator fires when amount exceeds threshold', () => {
    const trigger = makeTrigger({
      conditions: [{ type: 'input_field', field: 'amount', operator: 'gt', value: 1000 }],
    });
    expect(evaluator.evaluate([trigger], 'pay', { amount: 1500 }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'pay', { amount: 500 }, makeContext())).toBeNull();
  });

  it('input_field lt operator', () => {
    const trigger = makeTrigger({
      conditions: [{ type: 'input_field', field: 'qty', operator: 'lt', value: 5 }],
    });
    expect(evaluator.evaluate([trigger], 'order', { qty: 2 }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'order', { qty: 10 }, makeContext())).toBeNull();
  });

  it('input_field gte / lte operators', () => {
    const triggerGte = makeTrigger({
      conditions: [{ type: 'input_field', field: 'v', operator: 'gte', value: 10 }],
    });
    const triggerLte = makeTrigger({
      conditions: [{ type: 'input_field', field: 'v', operator: 'lte', value: 10 }],
    });
    expect(evaluator.evaluate([triggerGte], 'x', { v: 10 }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([triggerLte], 'x', { v: 10 }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([triggerGte], 'x', { v: 9 }, makeContext())).toBeNull();
    expect(evaluator.evaluate([triggerLte], 'x', { v: 11 }, makeContext())).toBeNull();
  });

  it('input_field eq / neq operators', () => {
    const triggerEq = makeTrigger({
      conditions: [{ type: 'input_field', field: 'env', operator: 'eq', value: 'prod' }],
    });
    const triggerNeq = makeTrigger({
      conditions: [{ type: 'input_field', field: 'env', operator: 'neq', value: 'dev' }],
    });
    expect(evaluator.evaluate([triggerEq], 'x', { env: 'prod' }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([triggerEq], 'x', { env: 'dev' }, makeContext())).toBeNull();
    expect(evaluator.evaluate([triggerNeq], 'x', { env: 'prod' }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([triggerNeq], 'x', { env: 'dev' }, makeContext())).toBeNull();
  });

  it('input_field in / not_in operators for scalar values', () => {
    const triggerIn = makeTrigger({
      conditions: [{ type: 'input_field', field: 'region', operator: 'in', value: ['us', 'eu'] }],
    });
    expect(evaluator.evaluate([triggerIn], 'x', { region: 'us' }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([triggerIn], 'x', { region: 'ap' }, makeContext())).toBeNull();
  });

  it('input_field in operator for array field value (any-match)', () => {
    const trigger = makeTrigger({
      conditions: [
        { type: 'input_field', field: 'tags', operator: 'in', value: ['critical', 'financial'] },
      ],
    });
    expect(
      evaluator.evaluate([trigger], 'x', { tags: ['routine', 'critical'] }, makeContext()),
    ).not.toBeNull();
    expect(
      evaluator.evaluate([trigger], 'x', { tags: ['routine', 'hr'] }, makeContext()),
    ).toBeNull();
  });

  it('input_field exists operator', () => {
    const trigger = makeTrigger({
      conditions: [
        { type: 'input_field', field: 'secretKey', operator: 'exists', value: undefined },
      ],
    });
    expect(evaluator.evaluate([trigger], 'x', { secretKey: 'abc' }, makeContext())).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'x', {}, makeContext())).toBeNull();
  });

  it('input_field regex operator', () => {
    const trigger = makeTrigger({
      conditions: [{ type: 'input_field', field: 'email', operator: 'regex', value: /^admin@/ }],
    });
    expect(
      evaluator.evaluate([trigger], 'x', { email: 'admin@corp.com' }, makeContext()),
    ).not.toBeNull();
    expect(
      evaluator.evaluate([trigger], 'x', { email: 'user@corp.com' }, makeContext()),
    ).toBeNull();
  });

  it('input_field reads nested dot-notation paths', () => {
    const trigger = makeTrigger({
      conditions: [{ type: 'input_field', field: 'payment.amount', operator: 'gt', value: 500 }],
    });
    expect(
      evaluator.evaluate([trigger], 'x', { payment: { amount: 1000 } }, makeContext()),
    ).not.toBeNull();
    expect(
      evaluator.evaluate([trigger], 'x', { payment: { amount: 100 } }, makeContext()),
    ).toBeNull();
  });

  // ─── Condition: context_field ─────────────────────────────────────────────

  it('context_field reads roles array with in operator', () => {
    const trigger = makeTrigger({
      conditions: [
        { type: 'context_field', field: 'roles', operator: 'in', value: ['admin', 'superuser'] },
      ],
    });
    expect(
      evaluator.evaluate([trigger], 'x', {}, makeContext({ roles: ['admin'] })),
    ).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'x', {}, makeContext({ roles: ['employee'] }))).toBeNull();
  });

  it('context_field reads tenantId with eq operator', () => {
    const trigger = makeTrigger({
      conditions: [{ type: 'context_field', field: 'tenantId', operator: 'eq', value: 'acme' }],
    });
    expect(
      evaluator.evaluate([trigger], 'x', {}, makeContext({ tenantId: 'acme' })),
    ).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'x', {}, makeContext({ tenantId: 'other' }))).toBeNull();
  });

  // ─── Condition: custom ────────────────────────────────────────────────────

  it('custom condition is called with toolName, input, and context', () => {
    let called = false;
    const trigger = makeTrigger({
      conditions: [
        {
          type: 'custom',
          evaluate: (toolName, input, context) => {
            called = true;
            return toolName === 'delete' && input.confirmed === true && context.userId === 'user-1';
          },
        },
      ],
    });
    const ctx = makeContext({ userId: 'user-1' });
    expect(evaluator.evaluate([trigger], 'delete', { confirmed: true }, ctx)).not.toBeNull();
    expect(called).toBe(true);
    expect(evaluator.evaluate([trigger], 'delete', { confirmed: false }, ctx)).toBeNull();
  });

  // ─── Multiple conditions (AND) ────────────────────────────────────────────

  it('all conditions must pass (AND logic)', () => {
    const trigger = makeTrigger({
      conditions: [
        { type: 'input_field', field: 'amount', operator: 'gt', value: 1000 },
        { type: 'context_field', field: 'tenantId', operator: 'eq', value: 'acme' },
      ],
    });
    const ctx = makeContext({ tenantId: 'acme' });
    expect(evaluator.evaluate([trigger], 'x', { amount: 5000 }, ctx)).not.toBeNull();
    expect(evaluator.evaluate([trigger], 'x', { amount: 500 }, ctx)).toBeNull();
    expect(
      evaluator.evaluate([trigger], 'x', { amount: 5000 }, makeContext({ tenantId: 'other' })),
    ).toBeNull();
  });

  // ─── First-match-wins ─────────────────────────────────────────────────────

  it('returns result for first matching trigger', () => {
    const t1 = makeTrigger({
      id: 't1',
      scope: { tools: ['finance.transfer'] },
      approvalConfig: { risk: 'low', approverRoles: ['supervisor'] },
    });
    const t2 = makeTrigger({
      id: 't2',
      scope: { all: true },
      approvalConfig: { risk: 'high', approverRoles: ['manager'] },
    });
    const result = evaluator.evaluate([t1, t2], 'finance.transfer', {}, makeContext());
    expect(result!.triggerId).toBe('t1');
    expect(result!.risk).toBe('low');
  });

  // ─── Return value ─────────────────────────────────────────────────────────

  it('returned ApprovalRequirement has correct fields', () => {
    const trigger = makeTrigger({
      id: 'trig-abc',
      name: 'Big Transfer',
      description: 'Transfer exceeds limit',
      approvalConfig: { risk: 'critical', approverRoles: ['cfo', 'vp'] },
    });
    const result = evaluator.evaluate([trigger], 'finance.transfer', {}, makeContext());
    expect(result).toMatchObject({
      triggerId: 'trig-abc',
      triggerName: 'Big Transfer',
      risk: 'critical',
      approverRoles: ['cfo', 'vp'],
      reason: 'Transfer exceeds limit',
    });
  });
});
