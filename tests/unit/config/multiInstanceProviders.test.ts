import { describe, it, expect } from 'vitest';
import { ConfigLoader, resolveLLMProviderType } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../../../src/types/index.js';

describe('resolveLLMProviderType', () => {
  it('infers the type of historical keys when `type` is omitted', () => {
    expect(resolveLLMProviderType('openai', {})).toBe('openai');
    expect(resolveLLMProviderType('claude', {})).toBe('claude');
    expect(resolveLLMProviderType('ollama', {})).toBe('ollama');
  });

  it('returns the explicit type verbatim (including custom types)', () => {
    expect(resolveLLMProviderType('x', { type: 'openai-compatible' })).toBe('openai-compatible');
    expect(resolveLLMProviderType('y', { type: 'my-adapter' })).toBe('my-adapter');
  });

  it('throws when a non-historical key omits `type`', () => {
    expect(() => resolveLLMProviderType('vllm-local', {})).toThrow(ConfigError);
  });
});

describe('multi-instance provider config validation', () => {
  it('accepts arbitrary instance names with an explicit type', () => {
    const cfg = ConfigLoader.from({
      llm: {
        defaultProvider: 'vllm-local',
        providers: {
          'vllm-local': {
            type: 'openai-compatible',
            baseUrl: 'http://vllm:8000/v1',
            defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
          },
        },
      },
    }).get();
    expect(cfg.llm.providers['vllm-local']?.type).toBe('openai-compatible');
    // Historical defaults are preserved by the deep merge (backward compat).
    expect(cfg.llm.providers['openai']?.defaultModel).toBe('gpt-6-sol');
  });

  it('rejects an arbitrary instance name without a type', () => {
    expect(() =>
      ConfigLoader.from({
        llm: { providers: { 'gateway-x': { baseUrl: 'http://gw/v1' } } },
      }),
    ).toThrow(ConfigError);
  });

  it('requires baseUrl for openai-compatible', () => {
    expect(() =>
      ConfigLoader.from({
        llm: { providers: { 'vllm-local': { type: 'openai-compatible' } } },
      }),
    ).toThrow(/baseUrl is required/);
  });

  it('does NOT require baseUrl for ollama (adapter default localhost), preserving compat', () => {
    // A historical config with an unset `${OLLAMA_BASE_URL}` (empty string) must
    // still load — the Ollama adapter defaults to http://localhost:11434.
    expect(() =>
      ConfigLoader.from({
        llm: { providers: { 'ollama-gpu': { type: 'ollama', baseUrl: '' } } },
      }),
    ).not.toThrow();
  });

  it('preserves the existing config shape (backward compatibility)', () => {
    // A pre-existing config with only the historical keys still validates and
    // keeps its values unchanged.
    const cfg = ConfigLoader.from({
      llm: {
        defaultProvider: 'openai',
        providers: {
          openai: { apiKey: 'sk', defaultModel: 'gpt-5', maxRetries: 3, timeoutMs: 30000 },
          ollama: {
            baseUrl: 'http://127.0.0.1:11434',
            defaultModel: 'qwen2.5:7b',
            timeoutMs: 120000,
          },
        },
      },
    }).get();
    expect(cfg.llm.providers['openai']?.defaultModel).toBe('gpt-5');
    expect(cfg.llm.providers['ollama']?.baseUrl).toBe('http://127.0.0.1:11434');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: routing by instance name through the adapter registry
// ─────────────────────────────────────────────────────────────────────────────

class RecordingProvider extends LLMProvider {
  override readonly name: string;
  readonly providerType = 'mock';
  public calls = 0;
  constructor(name: string) {
    super();
    this.name = name;
  }
  override async call(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return {
      content: `reply from ${this.name}`,
      stopReason: 'end',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      model: 'mock-model',
      provider: this.name,
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

describe('multi-instance routing (e2e via adapter registry)', () => {
  it('registers a config-declared custom instance and routes to it by name', async () => {
    const created: RecordingProvider[] = [];
    const config = ConfigLoader.from({
      llm: {
        defaultProvider: 'primary-mock',
        providers: {
          'primary-mock': { type: 'mock', defaultModel: 'mock-model' },
          'secondary-mock': { type: 'mock', defaultModel: 'mock-model' },
        },
      },
    }).get();

    const orch = await Orchestrator.fromConfig(config, {
      llmAdapters: {
        mock: (name) => {
          const p = new RecordingProvider(name);
          created.push(p);
          return p;
        },
      },
    });

    // Both instances registered independently under their own names.
    expect(created.map((p) => p.name).sort()).toEqual(['primary-mock', 'secondary-mock']);

    orch.registerAgent({
      id: 'agent-1',
      name: 'A',
      systemPrompt: 'test',
      skills: [],
      llmConfig: { provider: 'secondary-mock', model: 'mock-model' },
      memoryStrategy: { type: 'sliding_window', maxMessages: 10 },
      maxLoopIterations: 3,
    });

    const res = await orch.chat('agent-1', 'hi', { tenantId: 't', userId: 'u', roles: [] });
    expect(res.content).toBe('reply from secondary-mock');

    const secondary = created.find((p) => p.name === 'secondary-mock')!;
    const primary = created.find((p) => p.name === 'primary-mock')!;
    expect(secondary.calls).toBe(1);
    expect(primary.calls).toBe(0);
  });

  it('registers an openai-compatible instance alongside the default ollama', async () => {
    const config = ConfigLoader.from({
      llm: {
        providers: {
          'vllm-local': {
            type: 'openai-compatible',
            baseUrl: 'http://vllm:8000/v1',
            defaultModel: 'llama',
          },
        },
      },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    // Circuit state exists for both the compatible instance and default ollama.
    expect(orch.router.getCircuitState('vllm-local')).toBeDefined();
    expect(orch.router.getCircuitState('ollama')).toBeDefined();
  });
});
