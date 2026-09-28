import { LLMProvider, textOnlyCapabilities } from '../../src/index.js';
import type {
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ProviderProbe,
} from '../../src/index.js';

/**
 * Offline stand-in for a real model. It asks for a transfer whenever the user
 * mentions one — even when the ACL has hidden that tool — so the example shows
 * the second security layer stopping a call the caller is not allowed to make.
 */
export class ScriptedModel extends LLMProvider {
  readonly providerType = 'scripted';

  constructor(readonly name: string) {
    super();
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const last = req.messages[req.messages.length - 1];
    const base = {
      stopReason: 'end' as const,
      model: 'scripted',
      provider: this.name,
      latencyMs: 0,
    };
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    if (last?.role === 'tool') {
      return { ...base, usage, content: `Tool result: ${String(last.content)}` };
    }
    const text = typeof last?.content === 'string' ? last.content : '';
    if (/transfer/i.test(text)) {
      return {
        ...base,
        usage,
        stopReason: 'tool_use',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            toolName: 'payments.transfer',
            input: { from: 'ACC-1', to: 'ACC-2', amount: 500 },
          },
        ],
      };
    }
    return { ...base, usage, content: 'How can I help?' };
  }

  async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }

  async listModels(): Promise<string[]> {
    return ['scripted'];
  }

  capabilities(): ProviderCapabilities {
    return textOnlyCapabilities();
  }
}
