import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../../../src/types/index.js';

class MockLLMProvider extends LLMProvider {
  override readonly name = 'mock';
  readonly providerType = 'mock';
  override async call(_req: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'ok',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 1,
    };
  }
  override async validate(): Promise<boolean> {
    return true;
  }
  override async listModels(): Promise<string[]> {
    return [];
  }

  override capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}

const TMP_DIR = join(tmpdir(), 'agent349-orch-declarative');
const MODULE_SRC = `
export const echoTool = {
  name: 'echo',
  description: 'echoes',
  inputSchema: { type: 'object', properties: {} },
  async execute(input) { return { success: true, data: input }; },
};
`;
let MODULE_PATH: string;

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  MODULE_PATH = join(TMP_DIR, 'echo.mjs');
  await writeFile(MODULE_PATH, MODULE_SRC, 'utf-8');
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe('Orchestrator — declarative loading', () => {
  it('registers declared module tools, skills, and agents', async () => {
    const config = ConfigLoader.from({
      llm: { defaultProvider: 'mock', defaultModel: 'mock-model' },
      tools: {
        definitions: [{ name: 'echo', kind: 'module', module: MODULE_PATH, export: 'echoTool' }],
      },
      skills: [{ name: 'general', description: 'd', tools: ['echo'] }],
      agents: [{ id: 'a1', name: 'A1', systemPrompt: 'You are A1.', skills: ['general'] }],
    }).get();

    const orch = await Orchestrator.fromConfig(config);
    orch.registerProvider(new MockLLMProvider());

    expect(orch.toolRegistry.has('echo')).toBe(true);
    expect(orch.skillRegistry.get('general')?.tools.map((t) => t.name)).toEqual(['echo']);

    const res = await orch.chat('a1', 'hi', { tenantId: 't', userId: 'u', roles: [] });
    expect(res.content).toBe('ok');

    await orch.shutdown();
  });

  it('registers an internal rag.search tool from config', async () => {
    const config = ConfigLoader.from({
      tools: {
        definitions: [
          {
            name: 'rag.search',
            kind: 'internal',
            ref: 'rag.search',
            config: { collections: ['docs'], topK: 7 },
          },
        ],
      },
    }).get();

    const orch = await Orchestrator.fromConfig(config);
    expect(orch.toolRegistry.has('rag.search')).toBe(true);
    await orch.shutdown();
  });

  it('is a no-op when no declarative sections are present (backward compatible)', async () => {
    const config = ConfigLoader.from().get();
    const orch = await Orchestrator.fromConfig(config);
    expect(orch.toolRegistry.list()).toEqual([]);
    await orch.shutdown();
  });
});
