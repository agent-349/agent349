import { describe, it, expect, vi } from 'vitest';
import { LLMRouter } from '../../../src/llm/LLMRouter.js';
import {
  LLMProvider,
  supportsBatch,
  supportsFiles,
  textOnlyCapabilities,
} from '../../../src/llm/LLMProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import { imageFromBytes, text } from '../../../src/content/index.js';
import type {
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ProviderProbe,
} from '../../../src/types/index.js';

class TestProvider extends LLMProvider {
  override readonly name: string;
  override readonly providerType = 'test';
  readonly calls: LLMRequest[] = [];

  constructor(
    name: string,
    private readonly caps: Partial<ProviderCapabilities> = {},
    private readonly fail = false,
  ) {
    super();
    this.name = name;
  }

  override async call(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);
    if (this.fail) throw new ProviderError(this.name, 'primary is down', request.model);
    return {
      content: 'ok',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: request.model,
      provider: this.name,
      latencyMs: 1,
    };
  }

  override async validate(): Promise<ProviderProbe> {
    return { ok: true };
  }

  override async listModels(): Promise<string[]> {
    return [];
  }

  override capabilities(): ProviderCapabilities {
    return { ...textOnlyCapabilities(), ...this.caps };
  }
}

const visionCaps: Partial<ProviderCapabilities> = {
  input: { text: true, image: true, document: true, audio: false, video: false },
  structuredOutput: 'jsonSchema',
  structuredOutputWithTools: true,
};

function imageRequest(): LLMRequest {
  return {
    systemPrompt: '',
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [text('what is this?'), imageFromBytes(new Uint8Array([1]), 'image/png')],
      },
    ],
  };
}

describe('capability-aware fallback', () => {
  it('falls back normally for a plain text request', async () => {
    const primary = new TestProvider('primary', {}, true);
    const fallback = new TestProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    const response = await router.call(
      { systemPrompt: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      'primary',
      'fallback',
    );

    expect(response.provider).toBe('fallback');
  });

  it('does not consult capabilities at all for a text-only request', async () => {
    const primary = new TestProvider('primary');
    const fallback = new TestProvider('fallback');
    const spy = vi.spyOn(fallback, 'capabilities');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    await router.call(
      { systemPrompt: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      'primary',
      'fallback',
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to send an image to a fallback that cannot read images', async () => {
    const primary = new TestProvider('primary', visionCaps, true);
    const textOnly = new TestProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', textOnly],
      ]),
    );

    // The original failure is surfaced, not a truncated answer from the fallback.
    await expect(router.call(imageRequest(), 'primary', 'fallback')).rejects.toThrow(
      'primary is down',
    );
    expect(textOnly.calls).toHaveLength(0);
  });

  it('uses a fallback that does support the modality', async () => {
    const primary = new TestProvider('primary', visionCaps, true);
    const fallback = new TestProvider('fallback', visionCaps);
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    const response = await router.call(imageRequest(), 'primary', 'fallback');
    expect(response.provider).toBe('fallback');
  });

  it('refuses a schema-constrained request on a fallback without schema support', async () => {
    const primary = new TestProvider('primary', visionCaps, true);
    const fallback = new TestProvider('fallback', { structuredOutput: 'jsonMode' });
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
    );

    await expect(
      router.call(
        {
          systemPrompt: '',
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          responseFormat: { type: 'json_schema', schema: {} },
        },
        'primary',
        'fallback',
      ),
    ).rejects.toThrow('primary is down');
    expect(fallback.calls).toHaveLength(0);
  });

  it('explains why when the primary circuit is open and the fallback is incapable', async () => {
    const primary = new TestProvider('primary', visionCaps, true);
    const fallback = new TestProvider('fallback');
    const router = new LLMRouter(
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      { failureThreshold: 1, recoveryTimeMs: 60_000 },
    );

    // Trip the primary circuit with a text request.
    await expect(
      router.call(
        { systemPrompt: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        'primary',
        'fallback',
      ),
    ).resolves.toBeDefined();
    primary.calls.length = 0;

    await expect(router.call(imageRequest(), 'primary', 'fallback')).rejects.toThrow(
      /cannot serve this request/,
    );
  });
});

describe('capability type guards', () => {
  it('recognises a provider that declares and implements files', () => {
    const provider = new TestProvider('p', { files: true }) as TestProvider & {
      uploadFile: () => void;
    };
    expect(supportsFiles(provider)).toBe(false);

    provider.uploadFile = () => undefined;
    expect(supportsFiles(provider)).toBe(true);
  });

  it('does not treat a declared-but-unimplemented capability as available', () => {
    const provider = new TestProvider('p', { batch: true });
    expect(supportsBatch(provider)).toBe(false);
  });

  it('does not treat an implemented-but-undeclared capability as available', () => {
    const provider = new TestProvider('p') as TestProvider & { submitBatch: () => void };
    provider.submitBatch = () => undefined;
    expect(supportsBatch(provider)).toBe(false);
  });
});

describe('textOnlyCapabilities', () => {
  it('is the conservative baseline a custom provider can build on', () => {
    expect(textOnlyCapabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      input: { text: true, image: false, document: false, audio: false, video: false },
      sources: { url: false, providerFile: false },
      structuredOutput: 'none',
      structuredOutputWithTools: false,
      files: false,
      batch: false,
    });
  });
});
