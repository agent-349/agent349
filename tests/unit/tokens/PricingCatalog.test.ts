/**
 * PricingCatalog: prices and retirements from data, lookups that never guess,
 * cached and batch rates, layered overrides, and the shipped catalog.
 */
import { describe, it, expect } from 'vitest';
import { PricingCatalog } from '../../../src/tokens/PricingCatalog.js';
import type { PricingCatalogData } from '../../../src/tokens/PricingCatalog.js';
import { TokenTracker } from '../../../src/tokens/TokenTracker.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type {
  ExecutionContext,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from '../../../src/types/index.js';

const DATA: PricingCatalogData = {
  version: '2026-11-21',
  models: {
    'openai/gpt-6.1-sol': { input: 2, output: 10, cachedInput: 0.1, batchInput: 1, batchOutput: 5 },
    'openai/gpt-5': {
      input: 1.25,
      output: 10,
      deprecation: { shutdown: '2026-12-11', replacement: 'openai/gpt-6.1-sol' },
    },
    'openai/gpt-6-luna': { input: 0.1, output: 0.5 },
    'anthropic/claude-opus-5': { input: 5, output: 25, cachedInput: 0.5 },
    'openai/text-embedding-3-small': { mode: 'embedding', input: 0.02, output: 0 },
  },
};

const M = 1_000_000;

describe('PricingCatalog — lookups', () => {
  const catalog = new PricingCatalog({ catalog: DATA });

  it('prices an exact provider/model in USD per 1M tokens', () => {
    expect(
      catalog.estimate({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        inputTokens: M,
        outputTokens: M,
      }),
    ).toBe(12);
  });

  it('strips dated snapshot suffixes', () => {
    for (const model of ['gpt-6.1-sol-2026-06-11', 'gpt-6.1-sol-20260611']) {
      expect(catalog.estimate({ provider: 'openai', model, inputTokens: M, outputTokens: 0 })).toBe(
        2,
      );
    }
  });

  it('never prices by prefix: gpt-5.4-mini is not gpt-5', () => {
    expect(
      catalog.estimate({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        inputTokens: M,
        outputTokens: 0,
      }),
    ).toBeUndefined();
  });

  it('maps adapter types and aliases to catalog providers', () => {
    expect(catalog.resolve('claude', 'claude-opus-5')?.input).toBe(5);
    expect(catalog.resolve('anthropic', 'claude-opus-5')?.input).toBe(5);
  });

  it('does not let an openai-compatible server inherit OpenAI prices', () => {
    const c = new PricingCatalog({ catalog: DATA, providerTypes: { vllm: 'openai-compatible' } });
    expect(
      c.estimate({ provider: 'vllm', model: 'gpt-6.1-sol', inputTokens: M, outputTokens: 0 }),
    ).toBeUndefined();
    expect(
      c.estimate({
        provider: 'x',
        providerType: 'openai-compatible',
        model: 'gpt-6.1-sol',
        inputTokens: M,
        outputTokens: 0,
      }),
    ).toBeUndefined();
  });

  it('resolves instance names through providerTypes', () => {
    const c = new PricingCatalog({ catalog: DATA, providerTypes: { main: 'openai' } });
    expect(
      c.estimate({ provider: 'main', model: 'gpt-6-luna', inputTokens: M, outputTokens: M }),
    ).toBeCloseTo(0.6);
  });

  it('prices local providers at 0, not unknown', () => {
    expect(
      catalog.estimate({
        provider: 'ollama',
        model: 'qwen2.5:7b',
        inputTokens: M,
        outputTokens: M,
      }),
    ).toBe(0);
    expect(
      catalog.estimate({
        provider: 'tei',
        model: 'bge-reranker-v2-m3',
        inputTokens: M,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it('reports retirements', () => {
    expect(catalog.deprecation('openai', 'gpt-5')).toEqual({
      shutdown: '2026-12-11',
      replacement: 'openai/gpt-6.1-sol',
    });
    expect(catalog.deprecation('openai', 'gpt-6.1-sol')).toBeUndefined();
  });
});

describe('PricingCatalog — rates', () => {
  const catalog = new PricingCatalog({ catalog: DATA });

  it('prices cached input at the cached rate', () => {
    // 1M input of which 0.5M cached: 0.5 × 2 + 0.5 × 0.1
    expect(
      catalog.estimate({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        inputTokens: M,
        outputTokens: 0,
        cachedInputTokens: M / 2,
      }),
    ).toBeCloseTo(1.05);
  });

  it('applies batch rates only when declared', () => {
    expect(
      catalog.estimate({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        inputTokens: M,
        outputTokens: M,
        executionMode: 'batch',
      }),
    ).toBe(6);
    expect(
      catalog.estimate({
        provider: 'openai',
        model: 'gpt-6-luna',
        inputTokens: M,
        outputTokens: 0,
        executionMode: 'batch',
      }),
    ).toBeCloseTo(0.1);
  });
});

describe('PricingCatalog — overrides', () => {
  it('layers overrides by provider/model, instance name and bare model', () => {
    const c = new PricingCatalog({
      catalog: DATA,
      providerTypes: { azure: 'openai' },
      overrides: {
        'openai/gpt-6.1-sol': { input: 1.8 },
        'azure/gpt-6.1-sol': { input: 1.5, output: 8 },
        'my-model': { input: 3, output: 4 },
      },
    });
    expect(c.resolve('openai', 'gpt-6.1-sol')).toMatchObject({
      input: 1.8,
      output: 10,
      cachedInput: 0.1,
    });
    expect(
      c.estimate({ provider: 'azure', model: 'gpt-6.1-sol', inputTokens: M, outputTokens: M }),
    ).toBe(9.5);
    expect(
      c.estimate({ provider: 'anything', model: 'my-model', inputTokens: M, outputTokens: 0 }),
    ).toBe(3);
  });

  it('ignores an incomplete bare override for an unknown model', () => {
    const c = new PricingCatalog({ catalog: DATA, overrides: { 'my-model': { input: 3 } } });
    expect(c.estimate({ model: 'my-model', inputTokens: M, outputTokens: 0 })).toBeUndefined();
  });
});

describe('PricingCatalog — shipped data', () => {
  it('loads the catalog shipped with the SDK', () => {
    const c = new PricingCatalog();
    expect(c.size).toBeGreaterThan(50);
    expect(c.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.resolve('openai', 'gpt-6.1-sol')).toMatchObject({ input: 2, output: 10 });
    expect(c.deprecation('openai', 'gpt-5')?.shutdown).toBe('2026-12-11');
  });
});

describe('TokenTracker with the catalog', () => {
  const ctx: ExecutionContext = {
    tenantId: 't',
    userId: 'u',
    roles: [],
    sessionId: 's',
    agentId: 'a',
    requestId: 'r',
  };
  const range = { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) };

  it('prices records without a provider cost and flags unknown models once', async () => {
    const unknown: string[] = [];
    const tracker = new TokenTracker(
      new InMemoryAdapter(),
      {},
      new PricingCatalog({ catalog: DATA }),
      'observe',
      {
        onUnpriced: (p, m) => unknown.push(`${p}/${m}`),
      },
    );
    await tracker.record(ctx, {
      inputTokens: M,
      outputTokens: 0,
      totalTokens: M,
      provider: 'openai',
      model: 'gpt-6-luna',
    });
    await tracker.record(ctx, {
      inputTokens: 100,
      outputTokens: 0,
      totalTokens: 100,
      provider: 'openai',
      model: 'mystery',
    });
    await tracker.record(ctx, {
      inputTokens: 50,
      outputTokens: 0,
      totalTokens: 50,
      provider: 'openai',
      model: 'mystery',
    });

    const summary = await tracker.getByUser('t', 'u', range);
    expect(summary.totalCostUsd).toBeCloseTo(0.1);
    expect(summary.unpricedTokens).toBe(150);
    expect(unknown).toEqual(['openai/mystery']);
  });
});

class ScriptedProvider extends LLMProvider {
  readonly name = 'openai';
  readonly providerType = 'openai';
  override async call(req: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'OK',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: req.model,
      provider: 'openai',
      providerType: 'openai',
      latencyMs: 0,
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

describe('Orchestrator.validateModels() — retirements', () => {
  it('flags a configured model with an announced retirement', async () => {
    const orch = await Orchestrator.fromConfig(
      ConfigLoader.from({ llm: { defaultProvider: 'openai', defaultModel: 'gpt-5' } }).get(),
    );
    orch.registerProvider(new ScriptedProvider());
    const events: Record<string, unknown>[] = [];
    orch.events.on('model.deprecated', (e) => events.push(e.data as Record<string, unknown>));

    const report = await orch.validateModels({ rag: false });

    expect(report.ok).toBe(true);
    expect(report.models[0]!.deprecation).toMatchObject({
      shutdown: '2026-12-11',
      replacement: 'openai/gpt-6.1-sol',
    });
    expect(events[0]).toMatchObject({ role: 'llm', model: 'gpt-5', shutdown: '2026-12-11' });
    expect(orch.pricing?.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
