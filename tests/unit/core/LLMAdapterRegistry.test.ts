import { describe, it, expect } from 'vitest';
import { LLMAdapterRegistry } from '../../../src/core/LLMAdapterRegistry.js';
import { OpenAIProvider } from '../../../src/llm/OpenAIProvider.js';
import { OllamaProvider } from '../../../src/llm/OllamaProvider.js';
import { ClaudeProvider } from '../../../src/llm/ClaudeProvider.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import { ConfigError } from '../../../src/errors/index.js';
import type { LLMRequest, LLMResponse, ProviderCapabilities } from '../../../src/types/index.js';

describe('LLMAdapterRegistry', () => {
  it('builds an openai instance under its configured name', () => {
    const reg = new LLMAdapterRegistry();
    const p = reg.create('openai', 'openai-secondary', {
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p?.name).toBe('openai-secondary');
  });

  it('skips a cloud instance with no API key (returns undefined)', () => {
    const reg = new LLMAdapterRegistry();
    expect(reg.create('openai', 'openai', { defaultModel: 'gpt-4o' })).toBeUndefined();
    expect(reg.create('claude', 'claude', { defaultModel: 'x' })).toBeUndefined();
  });

  it('builds an openai-compatible instance without an API key', () => {
    const reg = new LLMAdapterRegistry();
    const p = reg.create('openai-compatible', 'vllm-local', {
      type: 'openai-compatible',
      baseUrl: 'http://vllm:8000/v1',
      defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p?.name).toBe('vllm-local');
  });

  it('builds ollama and claude instances with their names', () => {
    const reg = new LLMAdapterRegistry();
    const ollama = reg.create('ollama', 'ollama-gpu', {
      type: 'ollama',
      baseUrl: 'http://gpu:11434',
    });
    expect(ollama).toBeInstanceOf(OllamaProvider);
    expect(ollama?.name).toBe('ollama-gpu');

    const claude = reg.create('claude', 'claude-main', {
      type: 'claude',
      apiKey: 'sk-ant',
    });
    expect(claude).toBeInstanceOf(ClaudeProvider);
    expect(claude?.name).toBe('claude-main');
  });

  it('throws for an unregistered adapter type', () => {
    const reg = new LLMAdapterRegistry();
    expect(() => reg.create('mystery', 'x', {})).toThrow(ConfigError);
  });

  it('accepts and uses a custom adapter factory (extensibility)', () => {
    class MockProvider extends LLMProvider {
      override readonly name: string;
      readonly providerType = 'mock';
      constructor(name: string) {
        super();
        this.name = name;
      }
      override async call(_r: LLMRequest): Promise<LLMResponse> {
        return {
          content: 'ok',
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          model: 'm',
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

    const reg = new LLMAdapterRegistry({
      'my-adapter': (name) => new MockProvider(name),
    });
    const p = reg.create('my-adapter', 'custom-1', { type: 'my-adapter' });
    expect(p).toBeInstanceOf(MockProvider);
    expect(p?.name).toBe('custom-1');
  });
});
