import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import type { Skill, Tool, ToolResult } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' },
    async execute(): Promise<ToolResult> {
      return { success: true };
    },
  };
}

function makeSkill(name: string, overrides: Partial<Omit<Skill, 'name'>> = {}): Skill {
  return {
    name,
    description: `${name} skill`,
    tools: [],
    ...overrides,
  };
}

// Reusable tool instances
const toolA = makeTool('a');
const toolB = makeTool('b');
const toolC = makeTool('c');
const toolD = makeTool('d');

let registry: SkillRegistry;

beforeEach(() => {
  registry = new SkillRegistry();
});

// ─────────────────────────────────────────────────────────────────────────────
// register() / get() / list()
// ─────────────────────────────────────────────────────────────────────────────

describe('register / get / list', () => {
  it('get() returns undefined for an unregistered skill', () => {
    expect(registry.get('finance')).toBeUndefined();
  });

  it('register() makes get() return the skill', () => {
    const skill = makeSkill('finance');
    registry.register(skill);
    expect(registry.get('finance')).toBe(skill);
  });

  it('register() replaces an existing skill with the same name', () => {
    const v1 = makeSkill('hr', { description: 'v1' });
    const v2 = makeSkill('hr', { description: 'v2' });
    registry.register(v1);
    registry.register(v2);
    expect(registry.get('hr')).toBe(v2);
  });

  it('registering multiple skills makes all retrievable', () => {
    registry.register(makeSkill('finance'));
    registry.register(makeSkill('hr'));
    registry.register(makeSkill('rag'));
    expect(registry.get('finance')).toBeDefined();
    expect(registry.get('hr')).toBeDefined();
    expect(registry.get('rag')).toBeDefined();
  });

  it('list() is empty when nothing is registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('list() returns all skill names in insertion order', () => {
    registry.register(makeSkill('a'));
    registry.register(makeSkill('b'));
    registry.register(makeSkill('c'));
    expect(registry.list()).toEqual(['a', 'b', 'c']);
  });

  it('list() reflects the current state after re-registration (name stays, order preserved)', () => {
    registry.register(makeSkill('x'));
    registry.register(makeSkill('y'));
    registry.register(makeSkill('x')); // replace — keeps original insertion position in Map
    expect(registry.list()).toContain('x');
    expect(registry.list()).toContain('y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveTools()
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveTools()', () => {
  it('returns [] when skillNames is empty', () => {
    expect(registry.resolveTools([])).toEqual([]);
  });

  it('returns [] when none of the skill names are registered', () => {
    expect(registry.resolveTools(['unknown', 'also-unknown'])).toEqual([]);
  });

  it('skips unknown skill names without error', () => {
    registry.register(makeSkill('finance', { tools: [toolA] }));
    const tools = registry.resolveTools(['finance', 'ghost']);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(toolA);
  });

  it('returns tools of a single skill', () => {
    registry.register(makeSkill('finance', { tools: [toolA, toolB] }));
    const tools = registry.resolveTools(['finance']);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toBe(toolA);
    expect(tools[1]).toBe(toolB);
  });

  it('returns [] for a skill that has no tools', () => {
    registry.register(makeSkill('empty', { tools: [] }));
    expect(registry.resolveTools(['empty'])).toEqual([]);
  });

  it('combines tools from multiple skills in skillNames order', () => {
    registry.register(makeSkill('finance', { tools: [toolA, toolB] }));
    registry.register(makeSkill('hr', { tools: [toolC] }));

    const tools = registry.resolveTools(['finance', 'hr']);

    expect(tools).toHaveLength(3);
    expect(tools[0]).toBe(toolA);
    expect(tools[1]).toBe(toolB);
    expect(tools[2]).toBe(toolC);
  });

  it('order of returned tools follows skillNames order, not registration order', () => {
    registry.register(makeSkill('a', { tools: [toolA] }));
    registry.register(makeSkill('b', { tools: [toolB] }));

    // Request b before a
    const tools = registry.resolveTools(['b', 'a']);

    expect(tools[0]).toBe(toolB);
    expect(tools[1]).toBe(toolA);
  });

  it('deduplicates tools that appear in multiple skills (first occurrence wins)', () => {
    const shared = makeTool('shared');
    registry.register(makeSkill('alpha', { tools: [shared, toolA] }));
    registry.register(makeSkill('beta', { tools: [shared, toolB] })); // shared is duplicated

    const tools = registry.resolveTools(['alpha', 'beta']);

    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === 'shared')).toHaveLength(1); // deduplicated
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('deduplication keeps the tool from the first-listed skill', () => {
    const fromAlpha = makeTool('shared');
    const fromBeta = makeTool('shared');

    registry.register(makeSkill('alpha', { tools: [fromAlpha] }));
    registry.register(makeSkill('beta', { tools: [fromBeta] }));

    const tools = registry.resolveTools(['alpha', 'beta']);

    expect(tools.find((t) => t.name === 'shared')).toBe(fromAlpha);
  });

  it('returns actual Tool references (callable)', async () => {
    registry.register(makeSkill('finance', { tools: [toolA] }));
    const [resolved] = registry.resolveTools(['finance']);
    const result = await resolved?.execute({}, {} as never);
    expect(result?.success).toBe(true);
  });

  it('requesting the same skill twice does not duplicate its tools', () => {
    registry.register(makeSkill('x', { tools: [toolA, toolB] }));
    const tools = registry.resolveTools(['x', 'x']);
    expect(tools).toHaveLength(2); // toolA and toolB — no duplicates
  });

  it('resolves tools from four skills correctly', () => {
    registry.register(makeSkill('s1', { tools: [toolA] }));
    registry.register(makeSkill('s2', { tools: [toolB] }));
    registry.register(makeSkill('s3', { tools: [toolC] }));
    registry.register(makeSkill('s4', { tools: [toolD] }));

    const tools = registry.resolveTools(['s1', 's2', 's3', 's4']);

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveSystemPrompt()
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveSystemPrompt()', () => {
  it('returns "" when skillNames is empty', () => {
    expect(registry.resolveSystemPrompt([])).toBe('');
  });

  it('returns "" when no skill names are registered', () => {
    expect(registry.resolveSystemPrompt(['ghost'])).toBe('');
  });

  it('returns "" when registered skills have no systemPromptAddition', () => {
    registry.register(makeSkill('no-prompt', { tools: [] }));
    expect(registry.resolveSystemPrompt(['no-prompt'])).toBe('');
  });

  it('returns the single addition when one skill contributes', () => {
    registry.register(makeSkill('finance', { systemPromptAddition: 'Finance mode enabled.' }));
    expect(registry.resolveSystemPrompt(['finance'])).toBe('Finance mode enabled.');
  });

  it('joins additions from multiple skills with \\n\\n', () => {
    registry.register(makeSkill('a', { systemPromptAddition: 'Part A.' }));
    registry.register(makeSkill('b', { systemPromptAddition: 'Part B.' }));

    const result = registry.resolveSystemPrompt(['a', 'b']);

    expect(result).toBe('Part A.\n\nPart B.');
  });

  it('follows skillNames order, not registration order', () => {
    registry.register(makeSkill('first', { systemPromptAddition: 'First.' }));
    registry.register(makeSkill('second', { systemPromptAddition: 'Second.' }));

    // Request in reverse order
    const result = registry.resolveSystemPrompt(['second', 'first']);

    expect(result).toBe('Second.\n\nFirst.');
  });

  it('skips skills that have no systemPromptAddition without breaking the join', () => {
    registry.register(makeSkill('with', { systemPromptAddition: 'With.' }));
    registry.register(makeSkill('without')); // no systemPromptAddition

    const result = registry.resolveSystemPrompt(['with', 'without']);

    expect(result).toBe('With.'); // no trailing separator
  });

  it('skips unknown skill names without error', () => {
    registry.register(makeSkill('real', { systemPromptAddition: 'Real.' }));

    const result = registry.resolveSystemPrompt(['ghost', 'real', 'phantom']);

    expect(result).toBe('Real.');
  });

  it('three skills all with additions are joined in order', () => {
    registry.register(makeSkill('x', { systemPromptAddition: 'X.' }));
    registry.register(makeSkill('y', { systemPromptAddition: 'Y.' }));
    registry.register(makeSkill('z', { systemPromptAddition: 'Z.' }));

    expect(registry.resolveSystemPrompt(['x', 'y', 'z'])).toBe('X.\n\nY.\n\nZ.');
  });

  it('requesting the same skill twice includes its addition twice', () => {
    registry.register(makeSkill('dup', { systemPromptAddition: 'Dup.' }));

    // No dedup for prompt — each occurrence in skillNames contributes
    const result = registry.resolveSystemPrompt(['dup', 'dup']);

    expect(result).toBe('Dup.\n\nDup.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: resolveTools + resolveSystemPrompt together
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveTools + resolveSystemPrompt together', () => {
  it('a fully-configured skill contributes both tools and prompt addition', () => {
    registry.register(
      makeSkill('finance', {
        tools: [toolA, toolB],
        systemPromptAddition: 'Finance instructions.',
      }),
    );

    const tools = registry.resolveTools(['finance']);
    const prompt = registry.resolveSystemPrompt(['finance']);

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(prompt).toBe('Finance instructions.');
  });

  it('replacing a skill via re-register updates both tool and prompt resolution', () => {
    registry.register(makeSkill('hr', { tools: [toolA], systemPromptAddition: 'Old HR.' }));
    registry.register(makeSkill('hr', { tools: [toolB, toolC], systemPromptAddition: 'New HR.' }));

    expect(registry.resolveTools(['hr']).map((t) => t.name)).toEqual(['b', 'c']);
    expect(registry.resolveSystemPrompt(['hr'])).toBe('New HR.');
  });
});
