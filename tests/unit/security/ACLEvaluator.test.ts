import { describe, it, expect } from 'vitest';
import { ACLEvaluator } from '../../../src/security/ACLEvaluator.js';
import type { ACLPolicy, ACLCondition } from '../../../src/security/types.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeContext(roles: string[], meta: Record<string, unknown> = {}): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'user-1',
    roles,
    sessionId: 'sess-1',
    agentId: 'agent-1',
    requestId: 'req-1',
    metadata: meta,
  };
}

function makePolicy(allowedRoles: string[], opts: Partial<ACLPolicy> = {}): ACLPolicy {
  return {
    resourceType: 'tool',
    resourceId: 'test.resource',
    allowedRoles,
    ...opts,
  };
}

const evaluator = new ACLEvaluator();

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCondition()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLEvaluator.evaluateCondition()', () => {
  const ctx = makeContext(['admin'], { department: 'finance', region: '10.0.1.5' });

  describe('eq', () => {
    it('returns true when field equals value', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'eq', value: 'acme' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field does not equal value', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'eq', value: 'other' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('resolves nested field with dot notation', () => {
      const cond: ACLCondition = { field: 'metadata.department', operator: 'eq', value: 'finance' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false for missing nested field', () => {
      const cond: ACLCondition = { field: 'metadata.nonexistent', operator: 'eq', value: 'x' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });
  });

  describe('neq', () => {
    it('returns true when field does not equal value', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'neq', value: 'other' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field equals value', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'neq', value: 'acme' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });
  });

  describe('in', () => {
    it('returns true when field value is in the array', () => {
      const cond: ACLCondition = {
        field: 'metadata.department',
        operator: 'in',
        value: ['finance', 'exec'],
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field value is not in the array', () => {
      const cond: ACLCondition = {
        field: 'metadata.department',
        operator: 'in',
        value: ['hr', 'legal'],
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('returns false when value is not an array', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'in', value: 'acme' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });
  });

  describe('not_in', () => {
    it('returns true when field value is NOT in the array', () => {
      const cond: ACLCondition = {
        field: 'metadata.department',
        operator: 'not_in',
        value: ['hr', 'legal'],
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field value IS in the array', () => {
      const cond: ACLCondition = {
        field: 'metadata.department',
        operator: 'not_in',
        value: ['finance', 'exec'],
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('returns true when value is not an array', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'not_in', value: 'acme' };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });
  });

  describe('exists', () => {
    it('returns true when field exists and is not null/undefined', () => {
      const cond: ACLCondition = { field: 'tenantId', operator: 'exists', value: null };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns true for a nested field that exists', () => {
      const cond: ACLCondition = { field: 'metadata.department', operator: 'exists', value: null };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field does not exist', () => {
      const cond: ACLCondition = { field: 'metadata.missing', operator: 'exists', value: null };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('returns false when field is null', () => {
      const ctxWithNull = makeContext(['admin'], { nullField: null });
      const cond: ACLCondition = { field: 'metadata.nullField', operator: 'exists', value: null };
      expect(evaluator.evaluateCondition(cond, ctxWithNull)).toBe(false);
    });
  });

  describe('regex', () => {
    it('returns true when field matches the regex', () => {
      const cond: ACLCondition = {
        field: 'metadata.region',
        operator: 'regex',
        value: '^10\\.0\\.',
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(true);
    });

    it('returns false when field does not match the regex', () => {
      const cond: ACLCondition = {
        field: 'metadata.region',
        operator: 'regex',
        value: '^192\\.168\\.',
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('returns false when field does not exist', () => {
      const cond: ACLCondition = {
        field: 'metadata.nonexistent',
        operator: 'regex',
        value: '.*',
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });

    it('returns false for an invalid regex pattern (does not throw)', () => {
      const cond: ACLCondition = {
        field: 'tenantId',
        operator: 'regex',
        value: '[invalid(',
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false);
    });
  });

  describe('deep dot notation', () => {
    it('resolves 3-level deep path', () => {
      const deepCtx = makeContext(['user'], { org: { dept: { name: 'eng' } } });
      const cond: ACLCondition = {
        field: 'metadata.org.dept.name',
        operator: 'eq',
        value: 'eng',
      };
      expect(evaluator.evaluateCondition(cond, deepCtx)).toBe(true);
    });

    it('returns undefined (fails eq) when intermediate key missing', () => {
      const cond: ACLCondition = {
        field: 'metadata.org.dept.name',
        operator: 'eq',
        value: 'eng',
      };
      expect(evaluator.evaluateCondition(cond, ctx)).toBe(false); // ctx has no org
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluatePolicy()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLEvaluator.evaluatePolicy()', () => {
  describe('deniedRoles (priority)', () => {
    it('denies when user role is in deniedRoles', () => {
      const policy = makePolicy(['finance_viewer', 'admin'], { deniedRoles: ['blocked'] });
      const ctx = makeContext(['blocked', 'admin']);
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('denies even when user also has an allowedRole', () => {
      const policy = makePolicy(['*'], { deniedRoles: ['contractor'] });
      const ctx = makeContext(['contractor']);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(false);
    });

    it('does not deny when user has no denied role', () => {
      const policy = makePolicy(['admin'], { deniedRoles: ['blocked'] });
      const ctx = makeContext(['admin']);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(true);
    });

    it('includes the matched denied role in the reason', () => {
      const policy = makePolicy(['*'], { deniedRoles: ['temp', 'contractor'] });
      const ctx = makeContext(['contractor', 'reader']);
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.reason).toMatch(/contractor/);
    });
  });

  describe('allowedRoles whitelist', () => {
    it('allows when user has a matching allowed role', () => {
      const policy = makePolicy(['finance_viewer', 'finance_admin']);
      const ctx = makeContext(['finance_viewer']);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(true);
    });

    it('denies when user has none of the allowed roles', () => {
      const policy = makePolicy(['finance_viewer', 'finance_admin']);
      const ctx = makeContext(['hr_viewer']);
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('finance_viewer');
      expect(result.reason).toContain('hr_viewer');
    });

    it('allows when allowedRoles includes "*" (public)', () => {
      const policy = makePolicy(['*']);
      const ctx = makeContext(['random_role']);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(true);
    });

    it('allows when allowedRoles includes "*" even with empty roles', () => {
      const policy = makePolicy(['*']);
      const ctx = makeContext([]);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(true);
    });

    it('denies when user has no roles and policy is not public', () => {
      const policy = makePolicy(['admin']);
      const ctx = makeContext([]);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(false);
    });

    it('allows when user has one of multiple allowed roles', () => {
      const policy = makePolicy(['a', 'b', 'c']);
      expect(evaluator.evaluatePolicy(policy, makeContext(['b'])).allowed).toBe(true);
    });
  });

  describe('conditions (evaluated after role check)', () => {
    it('denies when a condition fails', () => {
      const policy = makePolicy(['admin'], {
        conditions: [{ field: 'tenantId', operator: 'eq', value: 'specific-tenant' }],
      });
      const ctx = makeContext(['admin']); // tenantId is 'acme', not 'specific-tenant'
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Condition failed');
    });

    it('allows when all conditions pass', () => {
      const policy = makePolicy(['admin'], {
        conditions: [
          { field: 'tenantId', operator: 'eq', value: 'acme' },
          { field: 'userId', operator: 'eq', value: 'user-1' },
        ],
      });
      const ctx = makeContext(['admin']);
      expect(evaluator.evaluatePolicy(policy, ctx).allowed).toBe(true);
    });

    it('short-circuits on first failing condition', () => {
      const policy = makePolicy(['admin'], {
        conditions: [
          { field: 'tenantId', operator: 'eq', value: 'wrong-tenant' }, // fails first
          { field: 'userId', operator: 'eq', value: 'user-1' },
        ],
      });
      const ctx = makeContext(['admin']);
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('tenantId');
    });

    it('does not evaluate conditions when role check fails (denied first)', () => {
      const policy = makePolicy(['admin'], {
        conditions: [{ field: 'tenantId', operator: 'eq', value: 'acme' }],
      });
      const ctx = makeContext(['reader']); // no 'admin' role
      const result = evaluator.evaluatePolicy(policy, ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Required roles');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluate() — full multi-policy evaluation
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLEvaluator.evaluate()', () => {
  describe('no policies → public', () => {
    it('allows access when no policies are registered', () => {
      const decision = evaluator.evaluate([], makeContext(['admin']), 'tool', 'some.tool');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toMatch(/public/i);
    });

    it('does not set matchedPolicy when no policies exist', () => {
      const decision = evaluator.evaluate([], makeContext([]), 'tool', 'x');
      expect(decision.matchedPolicy).toBeUndefined();
    });
  });

  describe('single policy', () => {
    it('allows when the single policy passes', () => {
      const policies = [makePolicy(['admin'])];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['admin']),
        'tool',
        'test.resource',
      );
      expect(decision.allowed).toBe(true);
    });

    it('denies when the single policy fails', () => {
      const policies = [makePolicy(['admin'])];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['reader']),
        'tool',
        'test.resource',
      );
      expect(decision.allowed).toBe(false);
    });

    it('sets matchedPolicy on denial', () => {
      const policies = [makePolicy(['admin'])];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['reader']),
        'tool',
        'test.resource',
      );
      expect(decision.matchedPolicy).toBe('tool:test.resource');
    });

    it('sets matchedPolicy on success', () => {
      const policies = [makePolicy(['admin'])];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['admin']),
        'tool',
        'test.resource',
      );
      expect(decision.matchedPolicy).toBe('tool:test.resource');
    });
  });

  describe('multiple policies (AND semantics)', () => {
    it('allows when all policies pass', () => {
      const policies = [makePolicy(['admin']), makePolicy(['admin', 'super'])];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['admin']),
        'tool',
        'test.resource',
      );
      expect(decision.allowed).toBe(true);
    });

    it('denies when any policy fails (first fails)', () => {
      const policies = [
        makePolicy(['admin']), // fails for 'reader'
        makePolicy(['*']), // would pass
      ];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['reader']),
        'tool',
        'test.resource',
      );
      expect(decision.allowed).toBe(false);
    });

    it('denies when any policy fails (second fails)', () => {
      const policies = [
        makePolicy(['*']), // passes
        makePolicy(['admin']), // fails for 'reader'
      ];
      const decision = evaluator.evaluate(
        policies,
        makeContext(['reader']),
        'tool',
        'test.resource',
      );
      expect(decision.allowed).toBe(false);
    });
  });

  describe('ACLDecision shape', () => {
    it('always has evaluatedAt as a Date', () => {
      const decision = evaluator.evaluate([], makeContext([]), 'tool', 'x');
      expect(decision.evaluatedAt).toBeInstanceOf(Date);
    });

    it('always has non-negative durationMs', () => {
      const decision = evaluator.evaluate([], makeContext([]), 'tool', 'x');
      expect(decision.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('always has a reason string', () => {
      const decision = evaluator.evaluate([], makeContext([]), 'tool', 'x');
      expect(typeof decision.reason).toBe('string');
      expect(decision.reason.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles user with multiple roles (one matches denied)', () => {
      const policies = [makePolicy(['*'], { deniedRoles: ['contractor'] })];
      const ctx = makeContext(['reader', 'contractor']); // has both reader and contractor
      expect(evaluator.evaluate(policies, ctx, 'tool', 'x').allowed).toBe(false);
    });

    it('handles user with multiple roles where one matches allowedRoles', () => {
      const policies = [makePolicy(['finance_viewer', 'admin'])];
      const ctx = makeContext(['reader', 'admin']); // has admin
      expect(evaluator.evaluate(policies, ctx, 'tool', 'x').allowed).toBe(true);
    });

    it('handles policy with both allowedRoles and conditions', () => {
      const policies = [
        makePolicy(['admin'], {
          conditions: [{ field: 'tenantId', operator: 'in', value: ['acme', 'corp'] }],
        }),
      ];
      const ctx = makeContext(['admin']); // tenantId = 'acme'
      expect(evaluator.evaluate(policies, ctx, 'tool', 'x').allowed).toBe(true);
    });

    it('reason includes condition field name when condition denies', () => {
      const policies = [
        makePolicy(['admin'], {
          conditions: [{ field: 'metadata.ipRange', operator: 'regex', value: '^10\\.' }],
        }),
      ];
      const ctx = makeContext(['admin'], { ipRange: '192.168.1.1' });
      const decision = evaluator.evaluate(policies, ctx, 'tool', 'x');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('metadata.ipRange');
    });
  });
});
