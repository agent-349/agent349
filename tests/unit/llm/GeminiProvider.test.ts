import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { GeminiProvider } from '../../../src/llm/gemini/GeminiProvider.js';
import type { GeminiClient } from '../../../src/llm/gemini/GeminiProvider.js';
import { ProviderError, UnsupportedCapabilityError } from '../../../src/errors/index.js';
import {
  documentFromPath,
  documentFromUrl,
  fromProviderFile,
  imageFromBytes,
  text,
} from '../../../src/content/index.js';
import type { LLMRequest } from '../../../src/types/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/media');

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

interface InteractionBody {
  model: string;
  input: Array<Record<string, unknown>>;
  store: boolean;
  system_instruction?: string;
  tools?: Array<Record<string, unknown>>;
  response_format?: Record<string, unknown>;
  generation_config?: Record<string, unknown>;
  safety_settings?: unknown;
  service_tier?: string;
  labels?: Record<string, string>;
  stream?: boolean;
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    model: 'gemini-flash-latest',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello!' }] }],
    usage: {
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_thought_tokens: 30,
      total_tokens: 150,
    },
    ...overrides,
  };
}

function makeClient(response: unknown = makeInteraction()): {
  client: GeminiClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(response);
  const client = {
    interactions: { create },
    files: {
      upload: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      download: vi.fn(),
    },
    batches: { create: vi.fn(), get: vi.fn(), cancel: vi.fn() },
    models: { list: vi.fn() },
  } as unknown as GeminiClient;
  return { client, create };
}

function makeProvider(response?: unknown) {
  const { client, create } = makeClient(response);
  return {
    provider: new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-flash-latest' }, client),
    create,
    client,
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'gemini-flash-latest',
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function bodyOf(create: ReturnType<typeof vi.fn>): InteractionBody {
  return (create.mock.calls[0] as [InteractionBody])[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('identity and capabilities', () => {
  it('defaults its instance name to "gemini" and reports its adapter type', () => {
    const { provider } = makeProvider();
    expect(provider.name).toBe('gemini');
    expect(provider.providerType).toBe('gemini');
  });

  it('uses a configured instance name', () => {
    const { client } = makeClient();
    const provider = new GeminiProvider({ apiKey: 'k', name: 'gemini-eu' }, client);
    expect(provider.name).toBe('gemini-eu');
  });

  it('declares every input modality, both URI sources, schemas and batch', () => {
    const { provider } = makeProvider();
    expect(provider.capabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      input: { text: true, image: true, document: true, audio: true, video: true },
      sources: { url: true, providerFile: true },
      structuredOutput: 'jsonSchema',
      structuredOutputWithTools: true,
      files: true,
      batch: true,
    });
  });
});

describe('request mapping', () => {
  it('never stores conversation state on the provider', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest());
    expect(bodyOf(create).store).toBe(false);
  });

  it('maps the system prompt to system_instruction', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ systemPrompt: 'Be terse.' }));
    expect(bodyOf(create).system_instruction).toBe('Be terse.');
  });

  it('maps sampling parameters into generation_config', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ temperature: 0.2, maxTokens: 512 }));
    expect(bodyOf(create).generation_config).toEqual({
      temperature: 0.2,
      max_output_tokens: 512,
    });
  });

  it('falls back to the configured default model', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ model: '' }));
    expect(bodyOf(create).model).toBe('gemini-flash-latest');
  });

  it('fails when neither the request nor the instance names a model', async () => {
    const { client } = makeClient();
    const provider = new GeminiProvider({ apiKey: 'k' }, client);
    await expect(provider.call(makeRequest({ model: '' }))).rejects.toThrow(
      UnsupportedCapabilityError,
    );
  });

  it('maps tools to function declarations', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        tools: [
          {
            name: 'get_balance',
            description: 'Balance',
            inputSchema: { type: 'object', properties: { account: { type: 'string' } } },
          },
        ],
      }),
    );

    expect(bodyOf(create).tools).toEqual([
      {
        type: 'function',
        name: 'get_balance',
        description: 'Balance',
        parameters: { type: 'object', properties: { account: { type: 'string' } } },
      },
    ]);
  });
});

describe('multimodal input', () => {
  it('sends inline image bytes as a base64 image block', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [text('what is this?'), imageFromBytes(new Uint8Array([1, 2]), 'image/png')],
          },
        ],
      }),
    );

    expect(bodyOf(create).input).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: Buffer.from([1, 2]).toString('base64'), mime_type: 'image/png' },
    ]);
  });

  it('reads a PDF from disk and sends it as a document block', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [{ role: 'user', content: [documentFromPath(join(FIXTURES, 'invoice.pdf'))] }],
      }),
    );

    const [block] = bodyOf(create).input as Array<{
      type: string;
      mime_type: string;
      data: string;
    }>;
    expect(block!.type).toBe('document');
    expect(block!.mime_type).toBe('application/pdf');
    expect(Buffer.from(block!.data, 'base64').subarray(0, 4).toString()).toBe('%PDF');
  });

  it('passes a URL straight through for the provider to fetch', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [{ role: 'user', content: [documentFromUrl('https://example.com/a.pdf')] }],
      }),
    );

    expect(bodyOf(create).input[0]).toEqual({
      type: 'document',
      uri: 'https://example.com/a.pdf',
      mime_type: 'application/pdf',
    });
  });

  it('references an uploaded file by its URI', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              fromProviderFile({
                fileId: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                provider: 'gemini',
                providerType: 'gemini',
                mimeType: 'application/pdf',
              }),
            ],
          },
        ],
      }),
    );

    expect(bodyOf(create).input[0]).toEqual({
      type: 'document',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
      mime_type: 'application/pdf',
    });
  });

  it('carries a per-block media resolution hint', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              imageFromBytes(new Uint8Array([1]), 'image/png', { mediaResolution: 'high' }),
            ],
          },
        ],
      }),
    );

    expect(bodyOf(create).input[0]).toMatchObject({ resolution: 'high' });
  });

  it('renders omitted media as an explicit note rather than dropping it', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'media_omitted',
                mediaType: 'document',
                mimeType: 'application/pdf',
                fileName: 'invoice.pdf',
                reason: 'not_persisted',
              },
            ],
          },
        ],
      }),
    );

    expect(bodyOf(create).input[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(bodyOf(create).input[0])).toContain('invoice.pdf');
  });
});

describe('structured output', () => {
  const schema = {
    type: 'object',
    properties: { total: { type: 'number' } },
    required: ['total'],
  };

  it('requests a JSON schema natively', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ responseFormat: { type: 'json_schema', schema } }));

    expect(bodyOf(create).response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema,
    });
  });

  it('reports native mode, parsing and skipped validation separately', async () => {
    const { provider } = makeProvider(
      makeInteraction({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"total": 302.5}' }] }],
      }),
    );

    const response = await provider.call(
      makeRequest({ responseFormat: { type: 'json_schema', schema } }),
    );

    expect(response.structured).toEqual({
      mode: 'native_schema',
      parsed: true,
      value: { total: 302.5 },
      validation: 'skipped',
    });
  });

  it('validates against the schema only when asked', async () => {
    const { provider } = makeProvider(
      makeInteraction({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"total": "many"}' }] }],
      }),
    );

    const response = await provider.call(
      makeRequest({ responseFormat: { type: 'json_schema', schema, validate: true } }),
    );

    expect(response.structured?.parsed).toBe(true);
    expect(response.structured?.validation).toBe('invalid');
    expect(response.structured?.validationErrors?.[0]).toContain('total');
  });

  it('reports a parse failure without losing the raw text', async () => {
    const { provider } = makeProvider(
      makeInteraction({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not json' }] }],
      }),
    );

    const response = await provider.call(makeRequest({ responseFormat: { type: 'json_object' } }));

    expect(response.structured).toEqual({
      mode: 'native_json',
      parsed: false,
      validation: 'skipped',
      rawText: 'not json',
    });
  });

  it('omits the structured report when no format was requested', async () => {
    const { provider } = makeProvider();
    const response = await provider.call(makeRequest());
    expect(response.structured).toBeUndefined();
  });
});

describe('response normalisation', () => {
  it('returns the model text and provider identity', async () => {
    const { provider } = makeProvider();
    const response = await provider.call(makeRequest());

    expect(response.content).toBe('Hello!');
    expect(response.provider).toBe('gemini');
    expect(response.providerType).toBe('gemini');
    expect(response.executionMode).toBe('sync');
    expect(response.stopReason).toBe('end');
  });

  it('counts thinking tokens as output, matching how they are billed', async () => {
    const { provider } = makeProvider();
    const response = await provider.call(makeRequest());

    expect(response.usage.inputTokens).toBe(100);
    expect(response.usage.outputTokens).toBe(50); // 20 visible + 30 thinking
    expect(response.usage.totalTokens).toBe(150);
    expect(response.performance?.reasoningTokens).toBe(30);
    expect(response.performance?.visibleOutputTokens).toBe(20);
  });

  it('surfaces per-modality token breakdowns when the provider reports them', async () => {
    const { provider } = makeProvider(
      makeInteraction({
        usage: {
          total_input_tokens: 538,
          total_output_tokens: 39,
          input_tokens_by_modality: [
            { modality: 'image', tokens: 532 },
            { modality: 'text', tokens: 6 },
          ],
        },
      }),
    );

    const response = await provider.call(makeRequest());
    expect(response.usage.inputByModality).toEqual([
      { modality: 'image', tokens: 532 },
      { modality: 'text', tokens: 6 },
    ]);
  });

  it('estimates cost from the pricing table', async () => {
    const { client } = makeClient();
    const provider = new GeminiProvider(
      { apiKey: 'k', pricing: { 'gemini-flash-latest': { input: 0.001, output: 0.002 } } },
      client,
    );

    const response = await provider.call(makeRequest());
    // 100 input * 0.001/1k + 50 output * 0.002/1k
    expect(response.usage.cost).toBeCloseTo(0.0002, 6);
  });

  it('maps a tool call and preserves its correlation id', async () => {
    const { provider } = makeProvider(
      makeInteraction({
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'call_1',
            name: 'get_balance',
            arguments: { account: '1001' },
          },
        ],
      }),
    );

    const response = await provider.call(makeRequest());
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { id: 'call_1', toolName: 'get_balance', input: { account: '1001' } },
    ]);
  });

  it('preserves thought signatures so a stateless next turn is accepted', async () => {
    const { provider, create } = makeProvider(
      makeInteraction({
        steps: [
          { type: 'thought', signature: 'SIG-1' },
          { type: 'function_call', id: 'call_1', name: 't', arguments: {} },
        ],
      }),
    );

    const first = await provider.call(makeRequest());
    const toolUse = first.contentBlocks?.find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ providerData: { geminiThoughtSignature: 'SIG-1' } });

    // Replaying that assistant turn puts the signature back on the wire.
    create.mockClear();
    await provider.call(
      makeRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: first.contentBlocks! },
          { role: 'tool', toolCallId: 'call_1', name: 't', content: '{"ok":true}' },
        ],
      }),
    );

    const input = bodyOf(create).input;
    expect(input).toContainEqual({ type: 'thought', signature: 'SIG-1' });
    expect(input).toContainEqual(
      expect.objectContaining({ type: 'function_result', call_id: 'call_1' }),
    );
  });

  it('includes the raw provider response only when asked', async () => {
    const { provider } = makeProvider();
    expect((await provider.call(makeRequest())).providerRaw).toBeUndefined();
    expect((await provider.call(makeRequest({ includeRaw: true }))).providerRaw).toBeDefined();
  });
});

describe('streaming', () => {
  it('forwards text deltas and reconstructs the final response', async () => {
    const events = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'i1', model: 'gemini-flash-latest' },
      },
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'S' } },
      { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Hola' } },
      { event_type: 'step.delta', index: 1, delta: { type: 'text', text: ' mundo' } },
      {
        event_type: 'interaction.completed',
        interaction: {
          status: 'completed',
          usage: { total_input_tokens: 5, total_output_tokens: 2 },
        },
      },
    ];
    const { client, create } = makeClient();
    create.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    });
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const tokens: string[] = [];
    const response = await provider.call(makeRequest({ onToken: (delta) => tokens.push(delta) }));

    expect(tokens).toEqual(['Hola', ' mundo']);
    expect(response.content).toBe('Hola mundo');
    expect(response.usage.inputTokens).toBe(5);
    expect(bodyOf(create).stream).toBe(true);
  });

  it('never emits a thought signature as a visible token', async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { event_type: 'step.start', index: 0, step: { type: 'thought' } };
        yield {
          event_type: 'step.delta',
          index: 0,
          delta: { type: 'thought_signature', signature: 'SECRET' },
        };
      },
    });
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    const tokens: string[] = [];
    await provider.call(makeRequest({ onToken: (delta) => tokens.push(delta) }));

    expect(tokens).toEqual([]);
  });
});

describe('provider options', () => {
  it('maps typed Gemini options onto their native fields', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({
        providerOptions: {
          gemini: {
            thinkingLevel: 'low',
            mediaResolution: 'high',
            serviceTier: 'flex',
            labels: { team: 'finance' },
            safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
          },
        },
      }),
    );

    const body = bodyOf(create);
    expect(body.generation_config).toMatchObject({
      thinking_level: 'low',
      media_resolution: 'high',
    });
    expect(body.service_tier).toBe('flex');
    expect(body.labels).toEqual({ team: 'finance' });
    expect(body.safety_settings).toHaveLength(1);
  });

  it('merges the raw escape hatch for options the SDK does not model', async () => {
    const { provider, create } = makeProvider();
    await provider.call(
      makeRequest({ providerOptions: { gemini: { raw: { some_new_flag: true } } } }),
    );

    expect(bodyOf(create)).toMatchObject({ some_new_flag: true });
  });

  it('keeps store:false even if the escape hatch tries to set it', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ providerOptions: { gemini: { raw: { store: true } } } }));

    expect(bodyOf(create).store).toBe(false);
  });

  it('ignores options aimed at other adapters', async () => {
    const { provider, create } = makeProvider();
    await provider.call(makeRequest({ providerOptions: { openai: { seed: 7 } } }));
    expect(JSON.stringify(bodyOf(create))).not.toContain('seed');
  });
});

describe('error handling', () => {
  it('wraps an API failure in a ProviderError carrying the status', async () => {
    const { client, create } = makeClient();
    const apiError = Object.assign(new Error('quota exceeded'), { status: 429 });
    create.mockRejectedValue(apiError);
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    await expect(provider.call(makeRequest())).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'gemini',
      statusCode: 429,
      model: 'gemini-flash-latest',
    });
  });

  it('surfaces an error reported inside a completed interaction', async () => {
    const { provider } = makeProvider(
      makeInteraction({ status: 'failed', error: { message: 'blocked by safety' } }),
    );

    await expect(provider.call(makeRequest())).rejects.toThrow(ProviderError);
  });

  it('does not re-wrap a capability error as a provider error', async () => {
    const { provider } = makeProvider();
    await expect(
      provider.call(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                fromProviderFile({
                  fileId: 'f',
                  provider: 'openai',
                  providerType: 'openai',
                }),
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(UnsupportedCapabilityError);
  });
});

describe('model listing', () => {
  it('strips the models/ prefix', async () => {
    const { client } = makeClient();
    (client.models.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { name: 'models/gemini-flash-latest' };
        yield { name: 'models/gemini-pro-latest' };
      },
    });
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect(await provider.listModels()).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
  });

  it('falls back to a static list when the API is unreachable', async () => {
    const { client } = makeClient();
    (client.models.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect((await provider.listModels()).length).toBeGreaterThan(0);
  });

  it('reports why a probe failed instead of throwing', async () => {
    const { client } = makeClient();
    (client.models.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad key'));
    const provider = new GeminiProvider({ apiKey: 'k' }, client);

    expect(await provider.validate()).toEqual({ ok: false, error: 'bad key' });
  });
});
