/**
 * The `rag.search` tool the Orchestrator auto-registers reads the caller's
 * session history, so a configured contextual rewriter also resolves
 * follow-ups in agentic (tool-driven) retrieval.
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { LLMProvider, textOnlyCapabilities } from '../../../src/llm/LLMProvider.js';
import type {
  ExecutionContext,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from '../../../src/types/index.js';

class RecordingProvider extends LLMProvider {
  override readonly name = 'mock';
  readonly providerType = 'mock';
  readonly requests: LLMRequest[] = [];
  override async call(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      content: 'What does the Pro plan cost?',
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

const CONTEXT: ExecutionContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  roles: ['reader'],
  sessionId: 'sess-history',
  agentId: 'agent-1',
  requestId: 'req-1',
};

describe('auto-registered rag.search — session history', () => {
  it('gives the contextual rewriter the session conversation', async () => {
    const config = ConfigLoader.from({
      rag: { queryRewriting: { strategy: 'contextual', llmProvider: 'mock', model: 'mock-model' } },
    }).get();
    const orch = await Orchestrator.fromConfig(config);
    const provider = new RecordingProvider();
    orch.registerProvider(provider);
    const history: LLMMessage[] = [
      { role: 'user', content: 'Tell me about the Pro plan' },
      { role: 'assistant', content: 'The Pro plan includes priority support.' },
    ];
    await orch.memory.save(CONTEXT.sessionId, history);

    void orch.rag; // builds the pipeline and registers rag.search
    const tool = orch.toolRegistry.get('rag.search')!;
    await tool.execute({ query: 'and how much is it?', collections: ['missing'] }, CONTEXT);

    expect(provider.requests).toHaveLength(1);
    const prompt = provider.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain('User: Tell me about the Pro plan');
    expect(prompt).toContain('Query to rewrite: and how much is it?');
    expect(provider.requests[0]!.reasoningEffort).toBe('minimal');
    await orch.shutdown();
  });
});
