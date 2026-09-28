import { describe, it, expect, vi } from 'vitest';
import { DataFilter } from '../../../src/security/DataFilter.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    sessionId: 's1',
    userId: 'u1',
    tenantId: 'tenant-A',
    roles: ['user'],
    metadata: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DataFilter', () => {
  // ── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('accepts no arguments (empty filter)', () => {
      const df = new DataFilter();
      expect(df.filter('any', [{ x: 1 }], makeCtx())).toEqual([{ x: 1 }]);
    });

    it('loads initial rules', () => {
      const df = new DataFilter([
        {
          scope: 'tool',
          toolName: 'hr.list',
          filterType: 'tenant_isolation',
          config: {},
        },
      ]);
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      expect(df.filter('hr.list', data, ctx)).toEqual([{ tenantId: 'A' }]);
    });
  });

  // ── addRule / removeRule ───────────────────────────────────────────────────

  describe('addRule()', () => {
    it('registers a rule applied on subsequent filter() calls', () => {
      const df = new DataFilter();
      df.addRule({ scope: 'tool', filterType: 'tenant_isolation', config: {} });
      const ctx = makeCtx({ tenantId: 'X' });
      expect(df.filter('any', [{ tenantId: 'X' }, { tenantId: 'Y' }], ctx)).toEqual([
        { tenantId: 'X' },
      ]);
    });
  });

  describe('removeRule()', () => {
    it('removes a matching rule and returns true', () => {
      const df = new DataFilter([
        { scope: 'tool', toolName: 'hr', filterType: 'tenant_isolation', config: {} },
      ]);
      expect(df.removeRule('tool', 'tenant_isolation', 'hr')).toBe(true);
      // Rule removed — data should pass through unchanged
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      expect(df.filter('hr', data, ctx)).toEqual(data);
    });

    it('returns false when no matching rule is found', () => {
      const df = new DataFilter();
      expect(df.removeRule('tool', 'tenant_isolation', 'nonexistent')).toBe(false);
    });

    it('removes only the first matching rule when duplicates exist', () => {
      const df = new DataFilter([
        { scope: 'tool', filterType: 'tenant_isolation', config: {} },
        { scope: 'tool', filterType: 'tenant_isolation', config: {} },
      ]);
      df.removeRule('tool', 'tenant_isolation', undefined);
      // One rule remains
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      expect(df.filter('any', data, ctx)).toEqual([{ tenantId: 'A' }]);
    });
  });

  // ── getRAGFilters() ────────────────────────────────────────────────────────

  describe('getRAGFilters()', () => {
    it('returns empty filter when no rules are registered', () => {
      const df = new DataFilter();
      expect(df.getRAGFilters(makeCtx())).toEqual({});
    });

    it('sets tenantId for tenant_isolation rule with scope rag', () => {
      const df = new DataFilter([{ scope: 'rag', filterType: 'tenant_isolation', config: {} }]);
      const ctx = makeCtx({ tenantId: 'tenant-42' });
      expect(df.getRAGFilters(ctx)).toEqual({ tenantId: 'tenant-42' });
    });

    it('sets accessRoles for role_based rule with scope rag', () => {
      const df = new DataFilter([{ scope: 'rag', filterType: 'role_based', config: {} }]);
      const ctx = makeCtx({ roles: ['admin', 'viewer'] });
      expect(df.getRAGFilters(ctx)).toEqual({ accessRoles: ['admin', 'viewer'] });
    });

    it('combines tenant_isolation and role_based into one RAGFilter', () => {
      const df = new DataFilter([
        { scope: 'rag', filterType: 'tenant_isolation', config: {} },
        { scope: 'rag', filterType: 'role_based', config: {} },
      ]);
      const ctx = makeCtx({ tenantId: 'corp', roles: ['manager'] });
      expect(df.getRAGFilters(ctx)).toEqual({ tenantId: 'corp', accessRoles: ['manager'] });
    });

    it('applies scope:all rules to RAG filters', () => {
      const df = new DataFilter([{ scope: 'all', filterType: 'tenant_isolation', config: {} }]);
      const ctx = makeCtx({ tenantId: 'all-scope-tenant' });
      expect(df.getRAGFilters(ctx).tenantId).toBe('all-scope-tenant');
    });

    it('ignores rules with scope:tool in getRAGFilters()', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'tenant_isolation', config: {} }]);
      expect(df.getRAGFilters(makeCtx())).toEqual({});
    });

    it('ignores custom rules in getRAGFilters()', () => {
      const df = new DataFilter([
        {
          scope: 'rag',
          filterType: 'custom',
          config: { customFilter: () => [] },
        },
      ]);
      expect(df.getRAGFilters(makeCtx())).toEqual({});
    });
  });

  // ── filter() — tenant_isolation ────────────────────────────────────────────

  describe('filter() — tenant_isolation', () => {
    it('keeps only records whose tenantId matches context.tenantId', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'tenant_isolation', config: {} }]);
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [
        { name: 'Alice', tenantId: 'A' },
        { name: 'Bob', tenantId: 'B' },
        { name: 'Carol', tenantId: 'A' },
      ];
      const result = df.filter('any', data, ctx);
      expect(result).toHaveLength(2);
      expect(result.map((r: { name: string }) => r.name)).toEqual(['Alice', 'Carol']);
    });

    it('returns empty array when no records match the tenant', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'tenant_isolation', config: {} }]);
      const data = [{ tenantId: 'B' }, { tenantId: 'C' }];
      expect(df.filter('any', data, makeCtx({ tenantId: 'A' }))).toEqual([]);
    });

    it('passes non-array data through unchanged', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'tenant_isolation', config: {} }]);
      const data = { tenantId: 'X', value: 42 };
      expect(df.filter('any', data, makeCtx({ tenantId: 'A' }))).toEqual(data);
    });

    it('applies rule scoped to toolName only for that tool', () => {
      const df = new DataFilter([
        { scope: 'tool', toolName: 'hr.list', filterType: 'tenant_isolation', config: {} },
      ]);
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      // Correct tool: filtered
      expect(df.filter('hr.list', data, ctx)).toEqual([{ tenantId: 'A' }]);
      // Different tool: pass-through
      expect(df.filter('other.tool', data, ctx)).toEqual(data);
    });
  });

  // ── filter() — role_based ──────────────────────────────────────────────────

  describe('filter() — role_based', () => {
    it('keeps records whose accessRoles overlaps with context.roles', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'role_based', config: {} }]);
      const ctx = makeCtx({ roles: ['manager', 'viewer'] });
      const data = [
        { label: 'A', accessRoles: ['manager'] },
        { label: 'B', accessRoles: ['admin'] },
        { label: 'C', accessRoles: ['viewer', 'admin'] },
      ];
      const result = df.filter('any', data, ctx);
      expect(result.map((r: { label: string }) => r.label)).toEqual(['A', 'C']);
    });

    it('treats items with no accessRoles field as public (always included)', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'role_based', config: {} }]);
      const ctx = makeCtx({ roles: ['viewer'] });
      const data = [
        { label: 'public' }, // no accessRoles
        { label: 'restricted', accessRoles: ['admin'] },
      ];
      const result = df.filter('any', data, ctx);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('public');
    });

    it('treats items with empty accessRoles array as public', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'role_based', config: {} }]);
      const ctx = makeCtx({ roles: [] });
      const data = [{ label: 'doc', accessRoles: [] }];
      expect(df.filter('any', data, ctx)).toHaveLength(1);
    });

    it('passes non-array data through unchanged', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'role_based', config: {} }]);
      const data = { label: 'scalar', accessRoles: ['admin'] };
      expect(df.filter('any', data, makeCtx({ roles: [] }))).toEqual(data);
    });

    it('excludes records when user has no matching roles', () => {
      const df = new DataFilter([{ scope: 'tool', filterType: 'role_based', config: {} }]);
      const ctx = makeCtx({ roles: ['viewer'] });
      const data = [{ accessRoles: ['admin', 'manager'] }];
      expect(df.filter('any', data, ctx)).toEqual([]);
    });
  });

  // ── filter() — custom ──────────────────────────────────────────────────────

  describe('filter() — custom', () => {
    it('delegates to customFilter and uses its return value', () => {
      const customFilter = vi.fn((data: unknown[]) => data.slice(0, 1));
      const df = new DataFilter([
        { scope: 'tool', filterType: 'custom', config: { customFilter } },
      ]);
      const data = [1, 2, 3];
      expect(df.filter('any', data, makeCtx())).toEqual([1]);
      expect(customFilter).toHaveBeenCalledOnce();
    });

    it('passes context to customFilter', () => {
      const capturedCtx: ExecutionContext[] = [];
      const df = new DataFilter([
        {
          scope: 'tool',
          filterType: 'custom',
          config: {
            customFilter: (data, ctx) => {
              capturedCtx.push(ctx);
              return data;
            },
          },
        },
      ]);
      const ctx = makeCtx({ userId: 'u99' });
      df.filter('any', [], ctx);
      expect(capturedCtx[0]!.userId).toBe('u99');
    });

    it('spec example: manager sees only their team, hr_admin sees all', () => {
      const df = new DataFilter([
        {
          scope: 'tool',
          toolName: 'hr.listEmployees',
          filterType: 'custom',
          config: {
            customFilter: (data: { managerId: string; name: string }[], ctx: ExecutionContext) => {
              if (ctx.roles.includes('hr_admin')) return data;
              return data.filter((emp) => emp.managerId === ctx.userId);
            },
          },
        },
      ]);
      const employees = [
        { name: 'Alice', managerId: 'u1' },
        { name: 'Bob', managerId: 'u2' },
        { name: 'Carol', managerId: 'u1' },
      ];

      // Manager u1 sees only their team
      const managerResult = df.filter(
        'hr.listEmployees',
        employees,
        makeCtx({ userId: 'u1', roles: ['manager'] }),
      );
      expect(managerResult.map((e: { name: string }) => e.name)).toEqual(['Alice', 'Carol']);

      // hr_admin sees everyone
      const adminResult = df.filter(
        'hr.listEmployees',
        employees,
        makeCtx({ userId: 'u99', roles: ['hr_admin'] }),
      );
      expect(adminResult).toHaveLength(3);
    });
  });

  // ── filter() — scope semantics ─────────────────────────────────────────────

  describe('filter() — scope semantics', () => {
    it('scope:all applies to tool filter()', () => {
      const df = new DataFilter([{ scope: 'all', filterType: 'tenant_isolation', config: {} }]);
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      expect(df.filter('any', data, ctx)).toEqual([{ tenantId: 'A' }]);
    });

    it('scope:rag does NOT apply to filter()', () => {
      const df = new DataFilter([{ scope: 'rag', filterType: 'tenant_isolation', config: {} }]);
      const ctx = makeCtx({ tenantId: 'A' });
      const data = [{ tenantId: 'A' }, { tenantId: 'B' }];
      // rag-scoped rule should be ignored by filter()
      expect(df.filter('any', data, ctx)).toEqual(data);
    });
  });

  // ── filter() — rule chaining ───────────────────────────────────────────────

  describe('filter() — rule chaining', () => {
    it('applies multiple rules in order (each rule sees the previous result)', () => {
      const df = new DataFilter([
        { scope: 'tool', filterType: 'tenant_isolation', config: {} },
        { scope: 'tool', filterType: 'role_based', config: {} },
      ]);
      const ctx = makeCtx({ tenantId: 'A', roles: ['viewer'] });
      const data = [
        { tenantId: 'A', accessRoles: ['viewer'] }, // passes both
        { tenantId: 'A', accessRoles: ['admin'] }, // fails role_based
        { tenantId: 'B', accessRoles: ['viewer'] }, // fails tenant_isolation
      ];
      const result = df.filter('any', data, ctx);
      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe('A');
    });
  });
});
