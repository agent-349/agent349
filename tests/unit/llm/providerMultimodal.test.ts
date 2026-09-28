import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { join } from 'node:path';
import { ClaudeProvider } from '../../../src/llm/ClaudeProvider.js';
import { OpenAIProvider } from '../../../src/llm/OpenAIProvider.js';
import { OllamaProvider } from '../../../src/llm/OllamaProvider.js';
import { UnsupportedCapabilityError } from '../../../src/errors/index.js';
import {
  documentFromBytes,
  documentFromPath,
  documentFromUrl,
  fromProviderFile,
  imageFromBytes,
  imageFromUrl,
  text,
} from '../../../src/content/index.js';
import type { LLMRequest } from '../../../src/types/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/media');
const PNG_BYTES = new Uint8Array([1, 2, 3]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

// ─────────────────────────────────────────────────────────────────────────────
// Claude
// ─────────────────────────────────────────────────────────────────────────────

function makeClaude(): {
  provider: ClaudeProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '{"total":10}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    model: 'claude-sonnet-4-20250514',
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message);

  const client = {
    messages: { create, batches: {} },
    models: { list: vi.fn() },
    beta: { files: { upload: vi.fn(), retrieveMetadata: vi.fn(), delete: vi.fn() } },
  } as unknown as Anthropic;

  return { provider: new ClaudeProvider({ apiKey: 'k' }, client), create };
}

function claudeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

describe('ClaudeProvider — multimodal input', () => {
  it('declares images, documents, both URI sources and schema output', () => {
    const { provider } = makeClaude();
    const capabilities = provider.capabilities();

    expect(provider.providerType).toBe('claude');
    expect(capabilities.input).toMatchObject({ image: true, document: true, video: false });
    expect(capabilities.structuredOutput).toBe('jsonSchema');
    expect(capabilities.structuredOutputWithTools).toBe(true);
  });

  it('sends inline image bytes as a base64 image block', async () => {
    const { provider, create } = makeClaude();
    await provider.call(
      claudeRequest({
        messages: [
          {
            role: 'user',
            content: [text('what is this?'), imageFromBytes(PNG_BYTES, 'image/png')],
          },
        ],
      }),
    );

    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    ]);
  });

  it('sends a PDF as a document block', async () => {
    const { provider, create } = makeClaude();
    await provider.call(
      claudeRequest({
        messages: [{ role: 'user', content: [documentFromPath(join(FIXTURES, 'invoice.pdf'))] }],
      }),
    );

    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    const [block] = body.messages[0]!.content as Array<{ type: string; source: { type: string } }>;
    expect(block!.type).toBe('document');
    expect(block!.source.type).toBe('base64');
  });

  it('passes a URL source through for Claude to fetch', async () => {
    const { provider, create } = makeClaude();
    await provider.call(
      claudeRequest({
        messages: [{ role: 'user', content: [documentFromUrl('https://example.com/a.pdf')] }],
      }),
    );

    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect(body.messages[0]!.content).toEqual([
      { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
    ]);
  });

  it('references a previously uploaded file by id', async () => {
    const { provider, create } = makeClaude();
    await provider.call(
      claudeRequest({
        messages: [
          {
            role: 'user',
            content: [
              fromProviderFile({
                fileId: 'file_123',
                provider: 'claude',
                providerType: 'claude',
                mimeType: 'application/pdf',
              }),
            ],
          },
        ],
      }),
    );

    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect(body.messages[0]!.content).toEqual([
      { type: 'document', source: { type: 'file', file_id: 'file_123' } },
    ]);
  });

  it('rejects an image type Claude does not accept', async () => {
    const { provider } = makeClaude();
    await expect(
      provider.call(
        claudeRequest({
          messages: [{ role: 'user', content: [imageFromBytes(PNG_BYTES, 'image/tiff')] }],
        }),
      ),
    ).rejects.toThrow(/not accepted/);
  });

  it('maps a JSON schema onto output_config', async () => {
    const { provider, create } = makeClaude();
    const schema = { type: 'object', properties: { total: { type: 'number' } } };
    await provider.call(claudeRequest({ responseFormat: { type: 'json_schema', schema } }));

    expect(create.mock.calls[0]![0]).toMatchObject({
      output_config: { format: { type: 'json_schema', schema } },
    });
  });

  it('reports the structured outcome on the response', async () => {
    const { provider } = makeClaude();
    const response = await provider.call(
      claudeRequest({
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { total: { type: 'number' } } },
          validate: true,
        },
      }),
    );

    expect(response.structured).toMatchObject({
      mode: 'native_schema',
      parsed: true,
      value: { total: 10 },
      validation: 'valid',
    });
  });

  it('replays a preserved thinking block verbatim, never as empty text', async () => {
    const { provider, create } = makeClaude();
    const thinking = { type: 'thinking', thinking: 'reasoning…', signature: 'SIG' };

    await provider.call(
      claudeRequest({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              // What #fromClaudeResponse produces for a block it does not model.
              { type: 'text', text: '', providerData: thinking },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    );

    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    // The preserved block goes back as-is; no empty text block is sent, which
    // Claude would reject.
    expect(body.messages[1]!.content).toEqual([thinking, { type: 'text', text: 'answer' }]);
  });

  it('maps typed Claude options and the raw escape hatch', async () => {
    const { provider, create } = makeClaude();
    await provider.call(
      claudeRequest({
        providerOptions: {
          claude: { topK: 5, stopSequences: ['END'], raw: { unknown_future_flag: 1 } },
        },
      }),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      top_k: 5,
      stop_sequences: ['END'],
      unknown_future_flag: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────

function makeOpenAI(config: Partial<ConstructorParameters<typeof OpenAIProvider>[0]> = {}): {
  provider: OpenAIProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '{"total":10}', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as unknown as OpenAI.ChatCompletion);

  const client = {
    chat: { completions: { create } },
    models: { list: vi.fn() },
    files: { create: vi.fn(), retrieve: vi.fn(), delete: vi.fn(), content: vi.fn() },
    batches: { create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() },
  } as unknown as OpenAI;

  return {
    provider: new OpenAIProvider({ apiKey: 'k', ...config }, client),
    create,
  };
}

function openaiRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4o',
    ...overrides,
  };
}

describe('OpenAIProvider — multimodal input', () => {
  it('declares full support for the official endpoint', () => {
    const { provider } = makeOpenAI();
    expect(provider.providerType).toBe('openai');
    expect(provider.capabilities()).toMatchObject({
      input: { image: true, document: true },
      structuredOutput: 'jsonSchema',
      files: true,
      batch: true,
    });
  });

  it('declares a conservative set for a third-party compatible endpoint', () => {
    const { provider } = makeOpenAI({ providerType: 'openai-compatible' });
    expect(provider.capabilities()).toMatchObject({
      input: { image: true, document: false },
      structuredOutput: 'jsonMode',
      files: false,
      batch: false,
    });
  });

  it('lets an operator declare what their compatible endpoint really does', () => {
    const { provider } = makeOpenAI({
      providerType: 'openai-compatible',
      capabilities: { structuredOutput: 'jsonSchema' },
    });
    expect(provider.capabilities().structuredOutput).toBe('jsonSchema');
  });

  it('sends an inline image as a data URI', async () => {
    const { provider, create } = makeOpenAI();
    await provider.call(
      openaiRequest({
        messages: [{ role: 'user', content: [imageFromBytes(PNG_BYTES, 'image/png')] }],
      }),
    );

    const body = create.mock.calls[0]![0] as OpenAI.ChatCompletionCreateParams;
    expect(body.messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
  });

  it('passes an image URL and its detail hint through', async () => {
    const { provider, create } = makeOpenAI();
    await provider.call(
      openaiRequest({
        messages: [{ role: 'user', content: [imageFromUrl('https://x/y.png', { detail: 'low' })] }],
      }),
    );

    const body = create.mock.calls[0]![0] as OpenAI.ChatCompletionCreateParams;
    expect(body.messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'low' } },
    ]);
  });

  it('sends a PDF as a file content part with a filename', async () => {
    const { provider, create } = makeOpenAI();
    await provider.call(
      openaiRequest({
        messages: [
          {
            role: 'user',
            content: [documentFromBytes(PNG_BYTES, 'application/pdf', undefined, 'invoice.pdf')],
          },
        ],
      }),
    );

    const body = create.mock.calls[0]![0] as OpenAI.ChatCompletionCreateParams;
    expect(body.messages[1]!.content).toEqual([
      {
        type: 'file',
        file: {
          filename: 'invoice.pdf',
          file_data: `data:application/pdf;base64,${PNG_B64}`,
        },
      },
    ]);
  });

  it('references an uploaded document by file id', async () => {
    const { provider, create } = makeOpenAI();
    await provider.call(
      openaiRequest({
        messages: [
          {
            role: 'user',
            content: [
              fromProviderFile({
                fileId: 'file-abc',
                provider: 'openai',
                providerType: 'openai',
                mimeType: 'application/pdf',
              }),
            ],
          },
        ],
      }),
    );

    const body = create.mock.calls[0]![0] as OpenAI.ChatCompletionCreateParams;
    expect(body.messages[1]!.content).toEqual([{ type: 'file', file: { file_id: 'file-abc' } }]);
  });

  it('explains that a document URL cannot be fetched by Chat Completions', async () => {
    const { provider } = makeOpenAI();
    await expect(
      provider.call(
        openaiRequest({
          messages: [{ role: 'user', content: [documentFromUrl('https://x/a.pdf')] }],
        }),
      ),
    ).rejects.toThrow(/does not fetch document URLs/);
  });

  it('maps a JSON schema onto response_format, naming it when the caller did not', async () => {
    const { provider, create } = makeOpenAI();
    const schema = { type: 'object', properties: { total: { type: 'number' } } };
    await provider.call(
      openaiRequest({ responseFormat: { type: 'json_schema', schema, strict: true } }),
    );

    const body = create.mock.calls[0]![0] as OpenAI.ChatCompletionCreateParams;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true },
    });
  });

  it('refuses a JSON schema on an endpoint that only declares JSON mode', async () => {
    const { provider } = makeOpenAI({ providerType: 'openai-compatible' });
    await expect(
      provider.call(openaiRequest({ responseFormat: { type: 'json_schema', schema: {} } })),
    ).rejects.toThrow(UnsupportedCapabilityError);
  });

  it('maps typed OpenAI options and the raw escape hatch', async () => {
    const { provider, create } = makeOpenAI();
    await provider.call(
      openaiRequest({
        providerOptions: { openai: { seed: 42, serviceTier: 'flex', raw: { future_flag: true } } },
      }),
    );

    expect(create.mock.calls[0]![0]).toMatchObject({
      seed: 42,
      service_tier: 'flex',
      future_flag: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────────────────────────────────────

function makeOllama() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        model: 'llava',
        message: { role: 'assistant', content: '{"total":10}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 5,
      }),
  });
  return { provider: new OllamaProvider({}, fetchMock), fetchMock };
}

function ollamaBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as Record<
    string,
    unknown
  >;
}

describe('OllamaProvider — images and format', () => {
  it('declares images but not documents, files or batch', () => {
    const { provider } = makeOllama();
    expect(provider.providerType).toBe('ollama');
    expect(provider.capabilities()).toMatchObject({
      input: { image: true, document: false },
      files: false,
      batch: false,
      structuredOutputWithTools: false,
    });
  });

  it('carries images out of band in the message images array', async () => {
    const { provider, fetchMock } = makeOllama();
    await provider.call({
      model: 'llava',
      systemPrompt: 'x',
      messages: [
        { role: 'user', content: [text('describe'), imageFromBytes(PNG_BYTES, 'image/png')] },
      ],
    });

    const messages = ollamaBody(fetchMock)['messages'] as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: 'user', content: 'describe', images: [PNG_B64] });
  });

  it('refuses a document instead of silently dropping it', async () => {
    const { provider } = makeOllama();
    await expect(
      provider.call({
        model: 'llava',
        systemPrompt: 'x',
        messages: [{ role: 'user', content: [documentFromBytes(PNG_BYTES, 'application/pdf')] }],
      }),
    ).rejects.toThrow(UnsupportedCapabilityError);
  });

  it('passes a JSON schema through the format field', async () => {
    const { provider, fetchMock } = makeOllama();
    const schema = { type: 'object', properties: { total: { type: 'number' } } };
    await provider.call({
      model: 'llava',
      systemPrompt: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: { type: 'json_schema', schema },
    });

    expect(ollamaBody(fetchMock)['format']).toEqual(schema);
  });

  it('refuses to combine structured output with tools, which it cannot guarantee', async () => {
    const { provider } = makeOllama();
    await expect(
      provider.call({
        model: 'llava',
        systemPrompt: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      }),
    ).rejects.toThrow(/cannot combine structured output with tool calling/);
  });
});
