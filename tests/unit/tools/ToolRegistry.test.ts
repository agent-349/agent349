import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import type { Tool, ExecutionContext, ToolResult } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

const OK: ToolResult = { success: true, data: null };

function makeTool(name: string, opts: Partial<Omit<Tool, 'name' | 'execute'>> = {}): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    ...opts,
    async execute(_input, _ctx): Promise<ToolResult> {
      return OK;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared registry (reset before each test)
// ─────────────────────────────────────────────────────────────────────────────

let registry: ToolRegistry;

beforeEach(() => {
  registry = new ToolRegistry();
});

// ─────────────────────────────────────────────────────────────────────────────
// register() / has() / get() / list()
// ─────────────────────────────────────────────────────────────────────────────

describe('register / has / get / list', () => {
  it('has() returns false before registration', () => {
    expect(registry.has('finance.getBalance')).toBe(false);
  });

  it('get() returns undefined before registration', () => {
    expect(registry.get('finance.getBalance')).toBeUndefined();
  });

  it('register() makes has() return true', () => {
    registry.register(makeTool('finance.getBalance'));
    expect(registry.has('finance.getBalance')).toBe(true);
  });

  it('register() makes get() return the tool', () => {
    const tool = makeTool('finance.getBalance');
    registry.register(tool);
    expect(registry.get('finance.getBalance')).toBe(tool);
  });

  it('get() returns the correct tool when multiple are registered', () => {
    const a = makeTool('a');
    const b = makeTool('b');
    registry.register(a);
    registry.register(b);
    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBe(b);
  });

  it('register() replaces an existing tool with the same name', () => {
    const original = makeTool('rag.search');
    const replacement = makeTool('rag.search');
    registry.register(original);
    registry.register(replacement);
    expect(registry.get('rag.search')).toBe(replacement);
  });

  it('list() is empty when nothing is registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('list() returns all registered tool names', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    registry.register(makeTool('c'));
    expect(registry.list()).toEqual(['a', 'b', 'c']);
  });

  it('list() reflects the current state after unregister', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    registry.unregister('a');
    expect(registry.list()).toEqual(['b']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerMany()
// ─────────────────────────────────────────────────────────────────────────────

describe('registerMany()', () => {
  it('registers all tools in the array', () => {
    const tools = [makeTool('a'), makeTool('b'), makeTool('c')];
    registry.registerMany(tools);
    for (const t of tools) {
      expect(registry.has(t.name)).toBe(true);
    }
  });

  it('registers with a shared skillName for each tool', () => {
    registry.registerMany([makeTool('hr.getEmployee'), makeTool('hr.listRoles')], 'hr');
    const descs = registry.getDescriptors({ skillName: 'hr' });
    expect(descs.map((d) => d.name)).toEqual(['hr.getEmployee', 'hr.listRoles']);
  });

  it('handles an empty array without error', () => {
    expect(() => registry.registerMany([])).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  it('overwrites tools from a previous registerMany call', () => {
    const v1 = makeTool('shared');
    const v2 = makeTool('shared');
    registry.registerMany([v1]);
    registry.registerMany([v2]);
    expect(registry.get('shared')).toBe(v2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unregister()
// ─────────────────────────────────────────────────────────────────────────────

describe('unregister()', () => {
  it('returns true and removes the tool when it exists', () => {
    registry.register(makeTool('rag.search'));
    const removed = registry.unregister('rag.search');
    expect(removed).toBe(true);
    expect(registry.has('rag.search')).toBe(false);
  });

  it('returns false for a name that was never registered', () => {
    expect(registry.unregister('never.registered')).toBe(false);
  });

  it('does not affect other registered tools', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    registry.unregister('a');
    expect(registry.has('b')).toBe(true);
  });

  it('removes the skill association along with the tool', () => {
    registry.register(makeTool('finance.getBalance'), 'finance');
    registry.unregister('finance.getBalance');
    // Re-registering without a skill name should not leak the old association.
    registry.register(makeTool('finance.getBalance'));
    expect(registry.getDescriptors({ skillName: 'finance' })).toHaveLength(0);
  });

  it('can re-register a tool after unregistering it', () => {
    const tool = makeTool('a');
    registry.register(tool);
    registry.unregister('a');
    registry.register(tool);
    expect(registry.has('a')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDescriptors() — no filter
// ─────────────────────────────────────────────────────────────────────────────

describe('getDescriptors() — no filter', () => {
  it('returns an empty array when nothing is registered', () => {
    expect(registry.getDescriptors()).toEqual([]);
  });

  it('returns one descriptor per registered tool', () => {
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));
    expect(registry.getDescriptors()).toHaveLength(2);
  });

  it('returned descriptor has the correct name and description', () => {
    registry.register(makeTool('finance.getBalance'));
    const [desc] = registry.getDescriptors();
    expect(desc?.name).toBe('finance.getBalance');
    expect(desc?.description).toBe('finance.getBalance tool');
  });

  it('returned object does not expose the execute function', () => {
    registry.register(makeTool('a'));
    const [desc] = registry.getDescriptors();
    expect('execute' in (desc ?? {})).toBe(false);
  });

  it('optional fields are included when set on the tool', () => {
    registry.register(
      makeTool('a', {
        tags: ['finance', 'read-only'],
        requiresApproval: true,
        timeout: 5000,
        outputSchema: { type: 'object' },
        retryPolicy: { maxRetries: 3, backoffMs: 500, backoffMultiplier: 2 },
      }),
    );
    const [desc] = registry.getDescriptors();
    expect(desc?.tags).toEqual(['finance', 'read-only']);
    expect(desc?.requiresApproval).toBe(true);
    expect(desc?.timeout).toBe(5000);
    expect(desc?.outputSchema).toEqual({ type: 'object' });
    expect(desc?.retryPolicy?.maxRetries).toBe(3);
  });

  it('optional fields are absent from the descriptor when not set on the tool', () => {
    registry.register(makeTool('minimal'));
    const [desc] = registry.getDescriptors();
    expect('tags' in (desc ?? {})).toBe(false);
    expect('outputSchema' in (desc ?? {})).toBe(false);
    expect('requiresApproval' in (desc ?? {})).toBe(false);
    expect('timeout' in (desc ?? {})).toBe(false);
    expect('retryPolicy' in (desc ?? {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDescriptors() — filter by names
// ─────────────────────────────────────────────────────────────────────────────

describe('getDescriptors() — filter.names', () => {
  beforeEach(() => {
    registry.registerMany([makeTool('a'), makeTool('b'), makeTool('c')]);
  });

  it('returns only the listed tools', () => {
    const descs = registry.getDescriptors({ names: ['a', 'c'] });
    expect(descs.map((d) => d.name).sort()).toEqual(['a', 'c']);
  });

  it('returns an empty array when no names match', () => {
    expect(registry.getDescriptors({ names: ['x', 'y'] })).toHaveLength(0);
  });

  it('returns a single tool when the list has one entry', () => {
    const descs = registry.getDescriptors({ names: ['b'] });
    expect(descs).toHaveLength(1);
    expect(descs[0]?.name).toBe('b');
  });

  it('ignores names that are not registered', () => {
    const descs = registry.getDescriptors({ names: ['a', 'missing'] });
    expect(descs).toHaveLength(1);
    expect(descs[0]?.name).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDescriptors() — filter by tags
// ─────────────────────────────────────────────────────────────────────────────

describe('getDescriptors() — filter.tags', () => {
  beforeEach(() => {
    registry.register(makeTool('finance.read', { tags: ['finance', 'read-only'] }));
    registry.register(makeTool('finance.write', { tags: ['finance', 'write'] }));
    registry.register(makeTool('hr.read', { tags: ['hr', 'read-only'] }));
    registry.register(makeTool('no-tags'));
  });

  it('returns tools that have the specified tag', () => {
    const names = registry.getDescriptors({ tags: ['finance'] }).map((d) => d.name);
    expect(names.sort()).toEqual(['finance.read', 'finance.write']);
  });

  it('requires ALL listed tags to be present (AND semantics)', () => {
    const names = registry.getDescriptors({ tags: ['finance', 'read-only'] }).map((d) => d.name);
    expect(names).toEqual(['finance.read']);
  });

  it('returns empty when no tool carries all required tags', () => {
    expect(registry.getDescriptors({ tags: ['finance', 'hr'] })).toHaveLength(0);
  });

  it('excludes tools with no tags', () => {
    const descs = registry.getDescriptors({ tags: ['finance'] });
    expect(descs.some((d) => d.name === 'no-tags')).toBe(false);
  });

  it('an empty tags array matches all tools', () => {
    // Vacuously true — every tool satisfies "has all of zero tags"
    expect(registry.getDescriptors({ tags: [] })).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDescriptors() — filter by skillName
// ─────────────────────────────────────────────────────────────────────────────

describe('getDescriptors() — filter.skillName', () => {
  beforeEach(() => {
    registry.registerMany(
      [makeTool('finance.getBalance'), makeTool('finance.transfer')],
      'finance',
    );
    registry.registerMany([makeTool('hr.getEmployee'), makeTool('hr.listRoles')], 'hr');
    registry.register(makeTool('standalone')); // no skill
  });

  it('returns only tools from the specified skill', () => {
    const names = registry.getDescriptors({ skillName: 'finance' }).map((d) => d.name);
    expect(names.sort()).toEqual(['finance.getBalance', 'finance.transfer']);
  });

  it('does not include tools from other skills', () => {
    const descs = registry.getDescriptors({ skillName: 'finance' });
    expect(descs.some((d) => d.name.startsWith('hr.'))).toBe(false);
  });

  it('does not include tools registered without a skill', () => {
    const descs = registry.getDescriptors({ skillName: 'finance' });
    expect(descs.some((d) => d.name === 'standalone')).toBe(false);
  });

  it('returns empty for an unknown skill name', () => {
    expect(registry.getDescriptors({ skillName: 'unknown' })).toHaveLength(0);
  });

  it('re-registering a tool without a skill clears the association', () => {
    // Replace finance.getBalance with no skill association
    registry.register(makeTool('finance.getBalance'));
    const descs = registry.getDescriptors({ skillName: 'finance' });
    expect(descs.some((d) => d.name === 'finance.getBalance')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDescriptors() — combined filters
// ─────────────────────────────────────────────────────────────────────────────

describe('getDescriptors() — combined filters', () => {
  beforeEach(() => {
    registry.register(
      makeTool('finance.getBalance', { tags: ['finance', 'read-only'] }),
      'finance',
    );
    registry.register(makeTool('finance.transfer', { tags: ['finance', 'write'] }), 'finance');
    registry.register(makeTool('hr.getEmployee', { tags: ['hr', 'read-only'] }), 'hr');
  });

  it('names + skillName: both filters applied', () => {
    const descs = registry.getDescriptors({
      names: ['finance.getBalance', 'hr.getEmployee'],
      skillName: 'finance',
    });
    // Only finance.getBalance matches both
    expect(descs).toHaveLength(1);
    expect(descs[0]?.name).toBe('finance.getBalance');
  });

  it('tags + skillName: intersection', () => {
    const descs = registry.getDescriptors({ tags: ['read-only'], skillName: 'finance' });
    expect(descs).toHaveLength(1);
    expect(descs[0]?.name).toBe('finance.getBalance');
  });

  it('names + tags + skillName: all three applied', () => {
    const descs = registry.getDescriptors({
      names: ['finance.getBalance', 'finance.transfer'],
      tags: ['write'],
      skillName: 'finance',
    });
    expect(descs).toHaveLength(1);
    expect(descs[0]?.name).toBe('finance.transfer');
  });

  it('returns empty when combined filters match nothing', () => {
    const descs = registry.getDescriptors({
      names: ['finance.getBalance'],
      tags: ['write'], // finance.getBalance has 'read-only', not 'write'
    });
    expect(descs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// execute() round-trip (the tool retrieved via get() is callable)
// ─────────────────────────────────────────────────────────────────────────────

describe('execute() round-trip', () => {
  it('the tool returned by get() is callable and returns the expected result', async () => {
    const tool = makeTool('echo');
    registry.register(tool);
    const retrieved = registry.get('echo');
    const result = await retrieved?.execute({}, CTX);
    expect(result?.success).toBe(true);
  });
});
