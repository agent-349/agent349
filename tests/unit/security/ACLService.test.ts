import { describe, it, expect } from 'vitest';
import { ACLService } from '../../../src/security/ACLService.js';
import type { ACLPolicy, FieldMaskRule, DataFilterRule } from '../../../src/security/types.js';
import type { ExecutionContext, ToolDescriptor } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeContext(roles: string[], tenantId = 'acme'): ExecutionContext {
  return {
    tenantId,
    userId: 'user-1',
    roles,
    sessionId: 'sess-1',
    agentId: 'agent-1',
    requestId: 'req-1',
  };
}

function makeTool(name: string): ToolDescriptor {
  return { name, description: `Tool ${name}`, inputSchema: { type: 'object' } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy management
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — policy management', () => {
  it('starts with no policies', () => {
    const acl = new ACLService();
    expect(acl.getPolicies('tool', 'any.tool')).toEqual([]);
  });

  it('addPolicy() registers a policy', () => {
    const acl = new ACLService();
    const policy: ACLPolicy = {
      resourceType: 'tool',
      resourceId: 'finance.getBalance',
      allowedRoles: ['finance_viewer'],
    };
    acl.addPolicy(policy);
    expect(acl.getPolicies('tool', 'finance.getBalance')).toHaveLength(1);
  });

  it('addPolicies() registers multiple policies', () => {
    const acl = new ACLService();
    acl.addPolicies([
      { resourceType: 'tool', resourceId: 'a', allowedRoles: ['admin'] },
      { resourceType: 'tool', resourceId: 'b', allowedRoles: ['admin'] },
    ]);
    expect(acl.getPolicies('tool', 'a')).toHaveLength(1);
    expect(acl.getPolicies('tool', 'b')).toHaveLength(1);
  });

  it('multiple addPolicy() calls accumulate policies for the same resource', () => {
    const acl = new ACLService();
    acl.addPolicy({ resourceType: 'tool', resourceId: 'x', allowedRoles: ['a'] });
    acl.addPolicy({ resourceType: 'tool', resourceId: 'x', allowedRoles: ['b'] });
    expect(acl.getPolicies('tool', 'x')).toHaveLength(2);
  });

  it('removePolicy() removes policies for a resource and returns true', () => {
    const acl = new ACLService();
    acl.addPolicy({ resourceType: 'tool', resourceId: 'x', allowedRoles: ['admin'] });
    expect(acl.removePolicy('tool', 'x')).toBe(true);
    expect(acl.getPolicies('tool', 'x')).toHaveLength(0);
  });

  it('removePolicy() returns false when no policy exists', () => {
    const acl = new ACLService();
    expect(acl.removePolicy('tool', 'nonexistent')).toBe(false);
  });

  it('config.policies are loaded at construction', () => {
    const acl = new ACLService({
      policies: [{ resourceType: 'tool', resourceId: 'boot.tool', allowedRoles: ['admin'] }],
    });
    expect(acl.getPolicies('tool', 'boot.tool')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluate()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — evaluate()', () => {
  it('allows when no policy is registered (public by default)', () => {
    const acl = new ACLService();
    const decision = acl.evaluate('tool', 'public.tool', makeContext([]));
    expect(decision.allowed).toBe(true);
  });

  it('allows when user has a required role', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'finance.getBalance',
      allowedRoles: ['finance_viewer'],
    });
    expect(
      acl.evaluate('tool', 'finance.getBalance', makeContext(['finance_viewer'])).allowed,
    ).toBe(true);
  });

  it('denies when user lacks required role', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'finance.getBalance',
      allowedRoles: ['finance_viewer'],
    });
    expect(acl.evaluate('tool', 'finance.getBalance', makeContext(['hr_viewer'])).allowed).toBe(
      false,
    );
  });

  it('allows when allowedRoles is ["*"] (public)', () => {
    const acl = new ACLService();
    acl.addPolicy({ resourceType: 'tool', resourceId: 'rag.search', allowedRoles: ['*'] });
    expect(acl.evaluate('tool', 'rag.search', makeContext(['any_role'])).allowed).toBe(true);
  });

  it('deniedRoles overrides allowedRoles (including *)', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'tool.x',
      allowedRoles: ['*'],
      deniedRoles: ['contractor'],
    });
    expect(acl.evaluate('tool', 'tool.x', makeContext(['contractor'])).allowed).toBe(false);
  });

  it('allows user with allowedRole who is not denied', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'tool.x',
      allowedRoles: ['admin'],
      deniedRoles: ['contractor'],
    });
    expect(acl.evaluate('tool', 'tool.x', makeContext(['admin'])).allowed).toBe(true);
  });

  it('evaluates conditions', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'hr.update',
      allowedRoles: ['hr_admin'],
      conditions: [{ field: 'tenantId', operator: 'eq', value: 'acme' }],
    });
    expect(acl.evaluate('tool', 'hr.update', makeContext(['hr_admin'], 'acme')).allowed).toBe(true);
    expect(acl.evaluate('tool', 'hr.update', makeContext(['hr_admin'], 'other')).allowed).toBe(
      false,
    );
  });

  it('returns ACLDecision with evaluatedAt and durationMs', () => {
    const acl = new ACLService();
    const d = acl.evaluate('tool', 'x', makeContext([]));
    expect(d.evaluatedAt).toBeInstanceOf(Date);
    expect(typeof d.durationMs).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterTools() / filterSkills()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — filterTools()', () => {
  it('returns all tools when no policies are registered (all public)', () => {
    const acl = new ACLService();
    const tools = [makeTool('a'), makeTool('b')];
    expect(acl.filterTools(tools, makeContext(['any'])).map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('includes tools the user has permission for', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'finance.getBalance',
      allowedRoles: ['finance_viewer'],
    });
    const tools = [makeTool('finance.getBalance'), makeTool('rag.search')];
    const result = acl.filterTools(tools, makeContext(['finance_viewer']));
    expect(result.map((t) => t.name)).toContain('finance.getBalance');
    expect(result.map((t) => t.name)).toContain('rag.search'); // public (no policy)
  });

  it('excludes tools the user does not have permission for', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'tool',
      resourceId: 'admin.deleteAll',
      allowedRoles: ['super_admin'],
    });
    const tools = [makeTool('admin.deleteAll'), makeTool('rag.search')];
    const result = acl.filterTools(tools, makeContext(['reader']));
    expect(result.map((t) => t.name)).not.toContain('admin.deleteAll');
    expect(result.map((t) => t.name)).toContain('rag.search');
  });

  it('returns empty array when user has no access to any tool', () => {
    const acl = new ACLService();
    acl.addPolicy({ resourceType: 'tool', resourceId: 'a', allowedRoles: ['admin'] });
    acl.addPolicy({ resourceType: 'tool', resourceId: 'b', allowedRoles: ['admin'] });
    const result = acl.filterTools([makeTool('a'), makeTool('b')], makeContext(['reader']));
    expect(result).toHaveLength(0);
  });
});

describe('ACLService — filterSkills()', () => {
  it('returns all skills when no policies registered', () => {
    const acl = new ACLService();
    expect(acl.filterSkills(['a', 'b'], makeContext([]))).toEqual(['a', 'b']);
  });

  it('filters out restricted skills', () => {
    const acl = new ACLService();
    acl.addPolicy({
      resourceType: 'skill',
      resourceId: 'finance',
      allowedRoles: ['finance_viewer'],
    });
    const result = acl.filterSkills(['finance', 'general'], makeContext(['reader']));
    expect(result).toContain('general');
    expect(result).not.toContain('finance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maskFields()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — maskFields()', () => {
  it('returns data unchanged when no mask rules registered', () => {
    const acl = new ACLService();
    const data = { salary: 50000, name: 'Alice' };
    expect(acl.maskFields('hr.getEmployee', data, makeContext(['admin']))).toEqual(data);
  });

  it('redacts field for user without visibleToRoles', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'hr.getEmployee',
      field: 'salary',
      maskType: 'redact',
      visibleToRoles: ['hr_admin'],
    });
    const data = { salary: 50000, name: 'Alice' };
    const result = acl.maskFields('hr.getEmployee', data, makeContext(['reader']));
    expect(result.salary).toBe('[REDACTED]');
    expect(result.name).toBe('Alice');
  });

  it('does not redact for user with visibleToRoles', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'hr.getEmployee',
      field: 'salary',
      maskType: 'redact',
      visibleToRoles: ['hr_admin'],
    });
    const data = { salary: 50000, name: 'Alice' };
    const result = acl.maskFields('hr.getEmployee', data, makeContext(['hr_admin']));
    expect(result.salary).toBe(50000);
  });

  it('applies partial masking (showLast)', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'hr.getEmployee',
      field: 'rut',
      maskType: 'partial',
      visibleToRoles: ['hr_admin'],
      partialConfig: { showLast: 3, maskChar: '*' },
    });
    const data = { rut: '12345678-9' };
    const result = acl.maskFields('hr.getEmployee', data, makeContext(['reader']));
    // '12345678-9' is 10 chars; showLast=3 → show last 3 '8-9', mask 7 chars
    expect(result.rut).toBe('*******8-9');
  });

  it('applies partial masking (showFirst)', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'code',
      maskType: 'partial',
      visibleToRoles: ['admin'],
      partialConfig: { showFirst: 2, maskChar: '#' },
    });
    const result = acl.maskFields('tool.x', { code: 'ABCDEF' }, makeContext(['reader']));
    expect(result.code).toBe('AB####');
  });

  it('applies hash masking', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'email',
      maskType: 'hash',
      visibleToRoles: ['admin'],
    });
    const result = acl.maskFields(
      'tool.x',
      { email: 'alice@example.com' },
      makeContext(['reader']),
    );
    expect(typeof result.email).toBe('string');
    expect(result.email).toHaveLength(64); // sha256 hex
    expect(result.email).not.toBe('alice@example.com');
  });

  it('applies custom mask function', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'secret',
      maskType: 'custom',
      visibleToRoles: ['admin'],
      customMask: (v) => `[CUSTOM:${String(v).length}]`,
    });
    const result = acl.maskFields('tool.x', { secret: 'hello' }, makeContext(['reader']));
    expect(result.secret).toBe('[CUSTOM:5]');
  });

  it('handles nested field path', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'employee.salary',
      maskType: 'redact',
      visibleToRoles: ['hr_admin'],
    });
    const data = { employee: { name: 'Alice', salary: 100000 } };
    const result = acl.maskFields('tool.x', data, makeContext(['reader']));
    expect(result.employee.salary).toBe('[REDACTED]');
    expect(result.employee.name).toBe('Alice');
  });

  it('does not mutate the original data', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'salary',
      maskType: 'redact',
      visibleToRoles: ['admin'],
    });
    const data = { salary: 99999 };
    acl.maskFields('tool.x', data, makeContext(['reader']));
    expect(data.salary).toBe(99999); // original unchanged
  });

  it('applies masking to each element when data is an array', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'salary',
      maskType: 'redact',
      visibleToRoles: ['admin'],
    });
    const data = [{ salary: 100 }, { salary: 200 }];
    const result = acl.maskFields('tool.x', data, makeContext(['reader']));
    expect(result[0].salary).toBe('[REDACTED]');
    expect(result[1].salary).toBe('[REDACTED]');
  });

  it('allows * in visibleToRoles (public field)', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'tool.x',
      field: 'name',
      maskType: 'redact',
      visibleToRoles: ['*'],
    });
    const result = acl.maskFields('tool.x', { name: 'Alice' }, makeContext(['reader']));
    expect(result.name).toBe('Alice'); // not masked because * = public
  });

  it('ignores mask rules for other tools', () => {
    const acl = new ACLService();
    acl.addMaskRule({
      toolName: 'other.tool',
      field: 'salary',
      maskType: 'redact',
      visibleToRoles: ['admin'],
    });
    const data = { salary: 99999 };
    const result = acl.maskFields('tool.x', data, makeContext(['reader']));
    expect(result.salary).toBe(99999); // rule is for other.tool, not applied
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addDataFilter() / getRAGFilters() / filterToolResult()
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — data filters', () => {
  describe('getRAGFilters()', () => {
    it('returns empty filter when no data filter rules registered', () => {
      const acl = new ACLService();
      expect(acl.getRAGFilters(makeContext(['reader']))).toEqual({});
    });

    it('adds tenantId filter for tenant_isolation rule (scope rag)', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'rag', filterType: 'tenant_isolation', config: {} });
      const filter = acl.getRAGFilters(makeContext(['reader'], 'acme'));
      expect(filter.tenantId).toBe('acme');
    });

    it('adds accessRoles filter for role_based rule (scope rag)', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'rag', filterType: 'role_based', config: {} });
      const filter = acl.getRAGFilters(makeContext(['finance_viewer', 'reader']));
      expect(filter.accessRoles).toEqual(['finance_viewer', 'reader']);
    });

    it('combines both tenant_isolation and role_based rules', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'rag', filterType: 'tenant_isolation', config: {} });
      acl.addDataFilter({ scope: 'rag', filterType: 'role_based', config: {} });
      const filter = acl.getRAGFilters(makeContext(['admin'], 'corp'));
      expect(filter.tenantId).toBe('corp');
      expect(filter.accessRoles).toEqual(['admin']);
    });

    it('ignores rules with scope "tool" when computing RAG filters', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'tool', filterType: 'tenant_isolation', config: {} });
      expect(acl.getRAGFilters(makeContext([]))).toEqual({});
    });

    it('applies scope "all" rules to RAG filters', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'all', filterType: 'tenant_isolation', config: {} });
      const filter = acl.getRAGFilters(makeContext([], 'x-tenant'));
      expect(filter.tenantId).toBe('x-tenant');
    });
  });

  describe('filterToolResult()', () => {
    const ctx = makeContext(['finance_viewer'], 'tenant-a');

    it('returns data unchanged when no filter rules registered', () => {
      const acl = new ACLService();
      const data = [
        { id: 1, tenantId: 'tenant-a' },
        { id: 2, tenantId: 'tenant-b' },
      ];
      expect(acl.filterToolResult('tool.x', data, ctx)).toHaveLength(2);
    });

    it('tenant_isolation: filters array by tenantId', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'tool', filterType: 'tenant_isolation', config: {} });
      const data = [
        { id: 1, tenantId: 'tenant-a' },
        { id: 2, tenantId: 'tenant-b' },
        { id: 3, tenantId: 'tenant-a' },
      ];
      const result = acl.filterToolResult('any.tool', data, ctx) as typeof data;
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.tenantId === 'tenant-a')).toBe(true);
    });

    it('role_based: filters array by accessRoles overlap', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'all', filterType: 'role_based', config: {} });
      const data = [
        { id: 1, accessRoles: ['finance_viewer'] }, // user has this role
        { id: 2, accessRoles: ['hr_admin'] }, // user does NOT have this role
        { id: 3 }, // no accessRoles → public
      ];
      const result = acl.filterToolResult('any.tool', data, ctx) as typeof data;
      expect(result.map((r) => r.id)).toEqual([1, 3]);
    });

    it('role_based: items without accessRoles are accessible (public)', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'all', filterType: 'role_based', config: {} });
      const data = [{ id: 1, name: 'public item' }];
      const result = acl.filterToolResult('any.tool', data, ctx);
      expect(result).toHaveLength(1);
    });

    it('custom: calls customFilter function', () => {
      const acl = new ACLService();
      acl.addDataFilter({
        scope: 'tool',
        toolName: 'finance.getTx',
        filterType: 'custom',
        config: {
          customFilter: (data: unknown[], c) =>
            (data as { amount: number }[]).filter(
              (item) => c.roles.includes('admin') || item.amount < 1000,
            ),
        },
      });
      const data = [{ amount: 500 }, { amount: 5000 }];
      const result = acl.filterToolResult('finance.getTx', data, makeContext(['reader']));
      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(500);
    });

    it('toolName scoped filter only applies to matching tool', () => {
      const acl = new ACLService();
      acl.addDataFilter({
        scope: 'tool',
        toolName: 'specific.tool',
        filterType: 'tenant_isolation',
        config: {},
      });
      const data = [
        { id: 1, tenantId: 'tenant-a' },
        { id: 2, tenantId: 'tenant-b' },
      ];
      // Called with a different tool name → no filtering applied
      const result = acl.filterToolResult('other.tool', data, ctx);
      expect(result).toHaveLength(2);
    });

    it('non-array data passes through for tenant_isolation and role_based', () => {
      const acl = new ACLService();
      acl.addDataFilter({ scope: 'all', filterType: 'tenant_isolation', config: {} });
      const data = { id: 1, tenantId: 'tenant-b' };
      // Non-array: can't filter by tenantId → pass through
      const result = acl.filterToolResult('tool.x', data, ctx);
      expect(result).toEqual(data);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// constructor — config loading
// ─────────────────────────────────────────────────────────────────────────────

describe('ACLService — constructor config', () => {
  it('loads mask rules from config', () => {
    const maskRule: FieldMaskRule = {
      toolName: 'tool.x',
      field: 'secret',
      maskType: 'redact',
      visibleToRoles: ['admin'],
    };
    const acl = new ACLService({ maskRules: [maskRule] });
    const result = acl.maskFields('tool.x', { secret: 'value' }, makeContext(['reader']));
    expect(result.secret).toBe('[REDACTED]');
  });

  it('loads data filter rules from config', () => {
    const dataFilter: DataFilterRule = {
      scope: 'rag',
      filterType: 'tenant_isolation',
      config: {},
    };
    const acl = new ACLService({ dataFilters: [dataFilter] });
    const filter = acl.getRAGFilters(makeContext([], 'my-tenant'));
    expect(filter.tenantId).toBe('my-tenant');
  });
});
