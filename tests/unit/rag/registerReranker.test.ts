import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { RerankerProvider } from '../../../src/rag/reranker/RerankerProvider.js';
import type { Passage, RerankResult } from '../../../src/rag/types.js';

class TagReranker extends RerankerProvider {
  override readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  override async rerank(_q: string, passages: Passage[], topK: number): Promise<RerankResult> {
    return { passages: passages.slice(0, topK), model: this.name, latencyMs: 0, tokensUsed: 0 };
  }
  override async validate(): Promise<boolean> {
    return true;
  }
}

async function makeOrch(): Promise<Orchestrator> {
  return Orchestrator.fromConfig(ConfigLoader.from().get());
}

describe('Orchestrator.registerReranker()', () => {
  it('applies a reranker registered before the RAG subsystem is built', async () => {
    const orch = await makeOrch();
    orch.registerReranker(new TagReranker('custom-a'));
    // First access builds the facade using the override.
    expect(orch.rag.pipeline.reranker?.name).toBe('custom-a');
  });

  it('applies a reranker registered after the RAG subsystem is built', async () => {
    const orch = await makeOrch();
    // Trigger lazy build first (no reranker configured by default).
    expect(orch.rag.pipeline.reranker).toBeUndefined();
    orch.registerReranker(new TagReranker('custom-b'));
    expect(orch.rag.pipeline.reranker?.name).toBe('custom-b');
  });

  it('clears the reranker when passed undefined', async () => {
    const orch = await makeOrch();
    orch.registerReranker(new TagReranker('custom-c'));
    expect(orch.rag.pipeline.reranker?.name).toBe('custom-c');
    orch.registerReranker(undefined);
    expect(orch.rag.pipeline.reranker).toBeUndefined();
  });

  it('takes precedence over rag.reranker config', async () => {
    const config = ConfigLoader.from({
      rag: { reranker: { provider: 'tei', baseUrl: 'http://tei:8090' } },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    orch.registerReranker(new TagReranker('override-wins'));
    expect(orch.rag.pipeline.reranker?.name).toBe('override-wins');
  });
});
