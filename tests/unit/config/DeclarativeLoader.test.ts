import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDeclarativeConfig } from '../../../src/config/DeclarativeLoader.js';
import type { DeclarativeLoadContext } from '../../../src/config/DeclarativeLoader.js';
import { ModuleResolver } from '../../../src/config/ModuleResolver.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { ToolLoadError, ConfigError } from '../../../src/errors/index.js';
import type { InternalToolContext } from '../../../src/tools/internalTools.js';
import type { RAGPipeline } from '../../../src/rag/RAGPipeline.js';

const TMP_DIR = join(tmpdir(), 'agent349-declarative-tests');

// A plain-JS ESM module exporting a Tool object and a (config) => Tool factory.
const MODULE_SRC = `
export const calculatorTool = {
  name: 'calculator',
  description: 'adds numbers',
  inputSchema: { type: 'object', properties: {} },
  async execute(input) { return { success: true, data: { sum: (input?.a ?? 0) + (input?.b ?? 0) } }; },
};
export function createGreeter(config) {
  return {
    name: 'greeter',
    description: 'greets',
    inputSchema: { type: 'object', properties: {} },
    async execute() { return { success: true, data: { greeting: config?.greeting ?? 'hi' } }; },
  };
}
export const notATool = { name: 'broken', description: 'no execute', inputSchema: {} };
`;

let MODULE_PATH: string;

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  MODULE_PATH = join(TMP_DIR, 'tools.mjs');
  await writeFile(MODULE_PATH, MODULE_SRC, 'utf-8');
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function makeCtx(overrides?: Partial<DeclarativeLoadContext>): DeclarativeLoadContext {
  const stubPipeline = {} as RAGPipeline;
  const internalToolContext: InternalToolContext = {
    getRAGPipeline: () => stubPipeline,
    ragRetrievalDefaults: {},
  };
  return {
    toolRegistry: new ToolRegistry(),
    skillRegistry: new SkillRegistry(),
    internalToolContext,
    resolver: new ModuleResolver(),
    loadMode: 'strict',
    emit: () => {},
    ...overrides,
  };
}

describe('loadDeclarativeConfig — module tools', () => {
  it('loads a Tool object export', async () => {
    const ctx = makeCtx();
    await loadDeclarativeConfig(
      {
        tools: [
          { name: 'calculator', kind: 'module', module: MODULE_PATH, export: 'calculatorTool' },
        ],
      },
      ctx,
    );
    expect(ctx.toolRegistry.has('calculator')).toBe(true);
  });

  it('instantiates a factory export with config', async () => {
    const ctx = makeCtx();
    await loadDeclarativeConfig(
      {
        tools: [
          {
            name: 'greeter',
            kind: 'module',
            module: MODULE_PATH,
            export: 'createGreeter',
            config: { greeting: 'hola' },
          },
        ],
      },
      ctx,
    );
    const tool = ctx.toolRegistry.get('greeter');
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, {} as never);
    expect(result.data.greeting).toBe('hola');
  });

  it('applies name and metadata overrides from the definition', async () => {
    const ctx = makeCtx();
    await loadDeclarativeConfig(
      {
        tools: [
          {
            name: 'calc2',
            kind: 'module',
            module: MODULE_PATH,
            export: 'calculatorTool',
            tags: ['math'],
            requiresApproval: true,
          },
        ],
      },
      ctx,
    );
    const tool = ctx.toolRegistry.get('calc2');
    expect(tool?.name).toBe('calc2');
    expect(tool?.tags).toEqual(['math']);
    expect(tool?.requiresApproval).toBe(true);
  });

  it('throws ToolLoadError when the named export is missing', async () => {
    const ctx = makeCtx();
    await expect(
      loadDeclarativeConfig(
        { tools: [{ name: 'x', kind: 'module', module: MODULE_PATH, export: 'nope' }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ToolLoadError);
  });

  it('throws ToolLoadError when the export is not a Tool', async () => {
    const ctx = makeCtx();
    await expect(
      loadDeclarativeConfig(
        { tools: [{ name: 'broken', kind: 'module', module: MODULE_PATH, export: 'notATool' }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ToolLoadError);
  });

  it('tolerant mode skips failing tools and emits an event', async () => {
    const events: string[] = [];
    const ctx = makeCtx({ loadMode: 'tolerant', emit: (e) => events.push(e) });
    await loadDeclarativeConfig(
      {
        tools: [
          { name: 'bad', kind: 'module', module: MODULE_PATH, export: 'nope' },
          { name: 'calculator', kind: 'module', module: MODULE_PATH, export: 'calculatorTool' },
        ],
      },
      ctx,
    );
    expect(ctx.toolRegistry.has('bad')).toBe(false);
    expect(ctx.toolRegistry.has('calculator')).toBe(true);
    expect(events).toContain('config.tool.load.error');
  });
});

describe('loadDeclarativeConfig — internal tools', () => {
  it('builds the rag.search internal tool', async () => {
    const ctx = makeCtx();
    await loadDeclarativeConfig(
      {
        tools: [
          {
            name: 'rag.search',
            kind: 'internal',
            ref: 'rag.search',
            config: { collections: ['docs'] },
          },
        ],
      },
      ctx,
    );
    expect(ctx.toolRegistry.has('rag.search')).toBe(true);
  });

  it('throws ToolLoadError for an unknown internal ref', async () => {
    const ctx = makeCtx();
    await expect(
      loadDeclarativeConfig(
        { tools: [{ name: 'x', kind: 'internal', ref: 'does.not.exist' }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ToolLoadError);
  });
});

describe('loadDeclarativeConfig — skills', () => {
  it('resolves skill tool references against the registry', async () => {
    const ctx = makeCtx();
    await loadDeclarativeConfig(
      {
        tools: [
          { name: 'calculator', kind: 'module', module: MODULE_PATH, export: 'calculatorTool' },
        ],
        skills: [
          {
            name: 'math',
            description: 'math skill',
            tools: ['calculator'],
            requiredRoles: ['user'],
          },
        ],
      },
      ctx,
    );
    const skill = ctx.skillRegistry.get('math');
    expect(skill?.tools.map((t) => t.name)).toEqual(['calculator']);
    expect(skill?.requiredRoles).toEqual(['user']);
  });

  it('throws ConfigError when a skill references an unknown tool', async () => {
    const ctx = makeCtx();
    await expect(
      loadDeclarativeConfig(
        { skills: [{ name: 'math', description: 'd', tools: ['ghost'] }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
