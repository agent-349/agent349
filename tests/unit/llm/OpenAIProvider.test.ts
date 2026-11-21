import { describe, it, expect, beforeEach, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAIProvider } from '../../../src/llm/OpenAIProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { LLMMessage, LLMRequest } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

type MockToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

function makeOpenAIResponse(
  overrides: Partial<{
    model: string;
    content: string | null;
    tool_calls: MockToolCall[];
    finish_reason: string | null;
    usage: NonNullable<OpenAI.ChatCompletion['usage']>;
  }> = {},
): OpenAI.ChatCompletion {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: overrides.model ?? 'gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: overrides.content !== undefined ? overrides.content : 'Hello!',
          tool_calls: overrides.tool_calls as OpenAI.ChatCompletionMessageToolCall[] | undefined,
          refusal: null,
        },
        finish_reason: (overrides.finish_reason ??
          'stop') as OpenAI.ChatCompletion.Choice['finish_reason'],
        logprobs: null,
      },
    ],
    usage: overrides.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  } as OpenAI.ChatCompletion;
}

function makeOpenAIChunk(
  delta: OpenAI.ChatCompletionChunk.Choice.Delta | null,
  options: {
    model?: string;
    finishReason?: OpenAI.ChatCompletionChunk.Choice['finish_reason'];
    usage?: OpenAI.ChatCompletion['usage'];
  } = {},
): OpenAI.ChatCompletionChunk {
  return {
    id: 'chatcmpl-stream-test',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: options.model ?? 'gpt-4o',
    choices:
      delta === null
        ? []
        : [
            {
              index: 0,
              delta,
              finish_reason: options.finishReason ?? null,
              logprobs: null,
            },
          ],
    ...(options.usage !== undefined && { usage: options.usage }),
  };
}

function makeOpenAIStream(
  chunks: OpenAI.ChatCompletionChunk[],
): AsyncIterable<OpenAI.ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeMockClient(
  overrides: {
    create?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    chat: { completions: { create: overrides.create ?? vi.fn() } },
    models: { list: overrides.list ?? vi.fn() },
  } as unknown as OpenAI;
}

const BASE_REQUEST: LLMRequest = {
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'gpt-4o',
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let mockCreate: ReturnType<typeof vi.fn>;
let provider: OpenAIProvider;

beforeEach(() => {
  mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
  provider = new OpenAIProvider({ apiKey: 'test-key' }, makeMockClient({ create: mockCreate }));
});

// ─────────────────────────────────────────────────────────────────────────────
// call() — basic
// ─────────────────────────────────────────────────────────────────────────────

describe('call() — basic', () => {
  it('calls chat.completions.create', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('passes the correct model', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].model).toBe('gpt-4o');
  });

  it('injects system prompt as the first message with role "system"', async () => {
    await provider.call(BASE_REQUEST);
    const [first] = mockCreate.mock.calls[0]![0].messages;
    expect(first).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('appends user messages after the system message', async () => {
    await provider.call(BASE_REQUEST);
    const messages = mockCreate.mock.calls[0]![0].messages;
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('passes temperature when provided', async () => {
    await provider.call({ ...BASE_REQUEST, temperature: 0.5 });
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0.5);
  });

  it('omits temperature when not provided', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].temperature).toBeUndefined();
  });

  it('passes maxTokens as max_completion_tokens (the modern, universally-accepted parameter)', async () => {
    await provider.call({ ...BASE_REQUEST, maxTokens: 512 });
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(512);
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBeUndefined();
  });

  it('omits max_completion_tokens when maxTokens is not provided', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBeUndefined();
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBeUndefined();
  });

  it('sets provider to "openai"', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.provider).toBe('openai');
  });

  it('returns the model from the API response', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ model: 'gpt-4o-2024-11-20' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.model).toBe('gpt-4o-2024-11-20');
  });

  it('latencyMs is a non-negative number', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('call() — streaming', () => {
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };

  it('requests a stream, forwards text deltas, and returns the accumulated response', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIStream([
        makeOpenAIChunk({ role: 'assistant' }),
        makeOpenAIChunk({ content: 'Hola' }),
        makeOpenAIChunk({ content: ' mundo' }),
        makeOpenAIChunk({}, { finishReason: 'stop' }),
        makeOpenAIChunk(null, { usage }),
      ]),
    );
    const deltas: string[] = [];

    const res = await provider.call({
      ...BASE_REQUEST,
      onToken: (delta) => deltas.push(delta),
    });

    expect(mockCreate.mock.calls[0]![0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(deltas).toEqual(['Hola', ' mundo']);
    expect(res.content).toBe('Hola mundo');
    expect(res.stopReason).toBe('end');
    expect(res.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });
    expect(res.performance).toMatchObject({
      streamOpenMs: expect.any(Number),
      timeToFirstChunkMs: expect.any(Number),
      timeToFirstTokenMs: expect.any(Number),
      generationMs: expect.any(Number),
      visibleOutputTokens: 3,
    });
  });

  it('reports reasoning, cached-input, and visible-output token breakdowns', async () => {
    const detailedUsage: NonNullable<OpenAI.ChatCompletion['usage']> = {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 5 },
    };
    mockCreate.mockResolvedValue(
      makeOpenAIStream([
        makeOpenAIChunk({ content: 'respuesta' }),
        makeOpenAIChunk({}, { finishReason: 'stop' }),
        makeOpenAIChunk(null, { usage: detailedUsage }),
      ]),
    );

    const res = await provider.call({ ...BASE_REQUEST, onToken: vi.fn() });

    expect(res.performance).toMatchObject({
      reasoningTokens: 5,
      cachedInputTokens: 12,
      visibleOutputTokens: 3,
    });
  });

  it('passes the AbortSignal to the OpenAI request options', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIStream([
        makeOpenAIChunk({ content: 'ok' }),
        makeOpenAIChunk({}, { finishReason: 'stop' }),
        makeOpenAIChunk(null, { usage }),
      ]),
    );
    const controller = new AbortController();

    await provider.call({
      ...BASE_REQUEST,
      onToken: vi.fn(),
      signal: controller.signal,
    });

    expect(mockCreate.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it('accumulates split tool-call deltas without forwarding them as text', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIStream([
        makeOpenAIChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'rag_', arguments: '{"query"' },
            },
          ],
        }),
        makeOpenAIChunk({
          tool_calls: [
            {
              index: 0,
              function: { name: 'search', arguments: ':"vacaciones"}' },
            },
          ],
        }),
        makeOpenAIChunk({}, { finishReason: 'tool_calls' }),
        makeOpenAIChunk(null, { usage }),
      ]),
    );
    const onToken = vi.fn();

    const res = await provider.call({
      ...BASE_REQUEST,
      tools: [
        {
          name: 'rag.search',
          description: 'Search documents',
          inputSchema: { type: 'object' },
        },
      ],
      onToken,
    });

    expect(onToken).not.toHaveBeenCalled();
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      {
        id: 'call_1',
        toolName: 'rag.search',
        input: { query: 'vacaciones' },
      },
    ]);
    expect(res.contentBlocks).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'call_1',
        toolName: 'rag.search',
        input: { query: 'vacaciones' },
      },
    ]);
  });

  it('retains parameter relaxation while opening a stream', async () => {
    const error = new OpenAI.BadRequestError(
      400,
      {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        param: 'max_completion_tokens',
        message: 'Unrecognized request argument',
      },
      'Unrecognized request argument',
      new Headers(),
    );
    mockCreate
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(
        makeOpenAIStream([
          makeOpenAIChunk({ content: 'ok' }),
          makeOpenAIChunk({}, { finishReason: 'stop' }),
          makeOpenAIChunk(null, { usage }),
        ]),
      );

    const res = await provider.call({
      ...BASE_REQUEST,
      maxTokens: 100,
      onToken: vi.fn(),
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(100);
    expect(mockCreate.mock.calls[1]![0].max_tokens).toBe(100);
    expect(mockCreate.mock.calls[1]![0].stream).toBe(true);
    expect(res.content).toBe('ok');
  });

  it('never retries after the stream has emitted output', async () => {
    const streamError = new OpenAI.BadRequestError(
      400,
      {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        param: 'temperature',
        message: 'Stream failed after output started',
      },
      'Stream failed after output started',
      new Headers(),
    );
    const partialStream: AsyncIterable<OpenAI.ChatCompletionChunk> = {
      async *[Symbol.asyncIterator]() {
        yield makeOpenAIChunk({ content: 'partial' });
        throw streamError;
      },
    };
    mockCreate.mockResolvedValue(partialStream);
    const onToken = vi.fn();

    await expect(
      provider.call({
        ...BASE_REQUEST,
        temperature: 0.2,
        onToken,
      }),
    ).rejects.toThrow(ProviderError);

    expect(onToken).toHaveBeenCalledOnce();
    expect(onToken).toHaveBeenCalledWith('partial');
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('keeps the existing non-streaming path when onToken is absent', async () => {
    await provider.call(BASE_REQUEST);

    expect(mockCreate.mock.calls[0]![0].stream).toBeUndefined();
    expect(mockCreate.mock.calls[0]![0].stream_options).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool translation: SDK ToolDescriptor → OpenAI function-calling format
// ─────────────────────────────────────────────────────────────────────────────

describe('tool translation', () => {
  it('wraps each tool as { type: "function", function: { name, description, parameters } }', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
    });

    const tools = mockCreate.mock.calls[0]![0].tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('search');
    expect(tools[0].function.description).toBe('Search the web');
    expect(tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
  });

  it('uses "parameters" (not "input_schema") in the function object', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });

    const fn = mockCreate.mock.calls[0]![0].tools[0].function;
    expect(fn.parameters).toBeDefined();
    expect(fn.input_schema).toBeUndefined();
  });

  it('passes all tools when multiple are provided', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [
        { name: 'a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'b', description: 'B', inputSchema: { type: 'object' } },
        { name: 'c', description: 'C', inputSchema: { type: 'object' } },
      ],
    });
    expect(mockCreate.mock.calls[0]![0].tools).toHaveLength(3);
  });

  it('sets tool_choice to "auto" when tools are provided', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(mockCreate.mock.calls[0]![0].tool_choice).toBe('auto');
  });

  it('omits tools and tool_choice when no tools are provided', async () => {
    await provider.call(BASE_REQUEST);
    const payload = mockCreate.mock.calls[0]![0];
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('omits tools when an empty array is provided', async () => {
    await provider.call({ ...BASE_REQUEST, tools: [] });
    expect(mockCreate.mock.calls[0]![0].tools).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing — text
// ─────────────────────────────────────────────────────────────────────────────

describe('response parsing — text', () => {
  it('extracts text content from message.content', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ content: 'Hello world' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('Hello world');
  });

  it('returns empty string when message.content is null', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
        finish_reason: 'tool_calls',
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing — tool calls
// ─────────────────────────────────────────────────────────────────────────────

describe('response parsing — tool calls', () => {
  it('extracts a single tool call', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]!.id).toBe('call_1');
    expect(res.toolCalls![0]!.toolName).toBe('search');
    expect(res.toolCalls![0]!.input).toEqual({ q: 'test' });
  });

  it('extracts multiple tool calls', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'calc', arguments: '{"expr":"1+1"}' } },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls![0]!.toolName).toBe('search');
    expect(res.toolCalls![1]!.toolName).toBe('calc');
  });

  it('parses JSON arguments from the function call', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 't', arguments: '{"x":42,"y":"hello"}' },
          },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls![0]!.input).toEqual({ x: 42, y: 'hello' });
  });

  it('falls back to {} when arguments JSON is malformed', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 't', arguments: 'NOT_JSON' } },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls![0]!.input).toEqual({});
  });

  it('toolCalls is undefined when no tool_calls in the response', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toBeUndefined();
  });

  it('handles mixed content (text + tool_calls)', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: 'Let me search.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('Let me search.');
    expect(res.toolCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finish reason mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('finish reason mapping', () => {
  it('maps "stop" → "end"', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ finish_reason: 'stop' }));
    expect((await provider.call(BASE_REQUEST)).stopReason).toBe('end');
  });

  it('maps "tool_calls" → "tool_use"', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        finish_reason: 'tool_calls',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
      }),
    );
    expect((await provider.call(BASE_REQUEST)).stopReason).toBe('tool_use');
  });

  it('maps "length" → "max_tokens"', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ finish_reason: 'length' }));
    expect((await provider.call(BASE_REQUEST)).stopReason).toBe('max_tokens');
  });

  it('maps "content_filter" → "end"', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ finish_reason: 'content_filter' }));
    expect((await provider.call(BASE_REQUEST)).stopReason).toBe('end');
  });

  it('maps null → "end"', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ finish_reason: null }));
    expect((await provider.call(BASE_REQUEST)).stopReason).toBe('end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Usage and cost
// ─────────────────────────────────────────────────────────────────────────────

describe('usage and cost', () => {
  it('maps prompt_tokens → inputTokens, completion_tokens → outputTokens', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.usage.inputTokens).toBe(200);
    expect(res.usage.outputTokens).toBe(80);
    expect(res.usage.totalTokens).toBe(280);
  });

  it('does not report a cost: the Orchestrator prices calls from the catalog', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ model: 'gpt-6.1-sol' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.usage.cost).toBeUndefined();
    expect(res.providerType).toBe('openai');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// contentBlocks round-trip preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('contentBlocks', () => {
  it('includes text block when content is non-empty', async () => {
    mockCreate.mockResolvedValue(makeOpenAIResponse({ content: 'Hi there' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toContainEqual({ type: 'text', text: 'Hi there' });
  });

  it('includes tool_use blocks for each tool call', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toContainEqual({
      type: 'tool_use',
      toolUseId: 'c1',
      toolName: 'search',
      input: { q: 'x' },
    });
  });

  it('includes both text and tool_use blocks in mixed responses', async () => {
    mockCreate.mockResolvedValue(
      makeOpenAIResponse({
        content: 'Searching...',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        finish_reason: 'tool_calls',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toHaveLength(2);
    expect(res.contentBlocks![0]!.type).toBe('text');
    expect(res.contentBlocks![1]!.type).toBe('tool_use');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Message translation: SDK → OpenAI format
// ─────────────────────────────────────────────────────────────────────────────

describe('message translation', () => {
  it('passes user string messages after the system message', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [{ role: 'user', content: 'Hello!' }],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Hello!' });
  });

  it('passes assistant string messages correctly', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello back' },
        { role: 'user', content: 'Thanks' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    // [0] = system, [1] = user, [2] = assistant, [3] = user
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Hello back' });
  });

  it('converts tool message to role:"tool" with tool_call_id', async () => {
    const toolMsg: LLMMessage = {
      role: 'tool',
      content: '{"result": 42}',
      toolCallId: 'call_abc',
      name: 'calculator',
    };

    await provider.call({
      ...BASE_REQUEST,
      messages: [{ role: 'user', content: 'Calculate' }, toolMsg],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const toolTurn = msgs.find((m: { role: string }) => m.role === 'tool');
    expect(toolTurn).toEqual({
      role: 'tool',
      content: '{"result": 42}',
      tool_call_id: 'call_abc',
    });
  });

  it('keeps each tool result as its own message (no grouping)', async () => {
    // OpenAI differs from Claude: separate messages per tool result.
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'tool', content: 'result-a', toolCallId: 'c1', name: 'toolA' },
        { role: 'tool', content: 'result-b', toolCallId: 'c2', name: 'toolB' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const toolMsgs = msgs.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].tool_call_id).toBe('c1');
    expect(toolMsgs[1].tool_call_id).toBe('c2');
  });

  it('converts assistant ContentBlock[] to tool_calls format', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', toolUseId: 'c1', toolName: 'search', input: { q: 'test' } },
          ],
        },
        { role: 'tool', content: 'results', toolCallId: 'c1', name: 'search' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const assistantMsg = msgs.find(
      (m: { role: string; tool_calls?: unknown }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBeNull();
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'search', arguments: JSON.stringify({ q: 'test' }) },
    });
  });

  it('serializes tool_use input as JSON string in tool_calls.function.arguments', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', toolUseId: 'c1', toolName: 'fn', input: { a: 1, b: 'x' } }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'fn' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const assistantMsg = msgs.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(typeof assistantMsg.tool_calls[0].function.arguments).toBe('string');
    expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ a: 1, b: 'x' });
  });

  it('includes text content alongside tool_calls in assistant ContentBlock[]', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search...' },
            { type: 'tool_use', toolUseId: 'c1', toolName: 'search', input: {} },
          ],
        },
        { role: 'tool', content: 'ok', toolCallId: 'c1', name: 'search' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const assistantMsg = msgs.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistantMsg.content).toBe('Let me search...');
  });

  it('skips system-role messages in the messages array', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'system', content: 'Extra system instruction' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const msgs = mockCreate.mock.calls[0]![0].messages;
    const systemMsgs = msgs.filter((m: { role: string }) => m.role === 'system');
    // Only the one injected from systemPrompt; the one in messages[] is skipped.
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toBe('You are helpful.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parameter relaxation: max_completion_tokens (default) → legacy max_tokens,
// and non-default temperature on reasoning-family models.
// ─────────────────────────────────────────────────────────────────────────────

describe('parameter relaxation', () => {
  // NOTE: OpenAI.APIError reads `.param`/`.code` directly off its 2nd
  // constructor argument (see `error.d.ts`: `this.param = data?.['param']`
  // where `data` IS that argument) — it is NOT nested under an `.error` key.
  // That nesting is only present in the raw HTTP response body, which
  // `APIError.generate()` unwraps before calling the constructor.
  function unsupportedParamError(param: string, message: string): OpenAI.BadRequestError {
    return new OpenAI.BadRequestError(
      400,
      { type: 'invalid_request_error', code: 'unsupported_parameter', param, message },
      message,
      new Headers(),
    );
  }

  it('sends max_completion_tokens on the first attempt for every model (no prior failure needed)', async () => {
    await provider.call({ ...BASE_REQUEST, model: 'gpt-5', maxTokens: 4096 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(4096);
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBeUndefined();
  });

  it('maps reasoningEffort to reasoning_effort', async () => {
    await provider.call({
      ...BASE_REQUEST,
      model: 'gpt-5',
      reasoningEffort: 'minimal',
    });

    expect(mockCreate.mock.calls[0]![0].reasoning_effort).toBe('minimal');
  });

  it('substitutes the closest accepted reasoning effort before dropping it', async () => {
    // Newer model families accept 'none' but reject 'minimal'.
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError(
          'reasoning_effort',
          "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.",
        ),
      )
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-6-luna' }))
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-6-luna' }));

    await provider.call({ ...BASE_REQUEST, model: 'gpt-6-luna', reasoningEffort: 'minimal' });
    await provider.call({ ...BASE_REQUEST, model: 'gpt-6-luna', reasoningEffort: 'minimal' });

    expect(mockCreate.mock.calls[0]![0].reasoning_effort).toBe('minimal');
    expect(mockCreate.mock.calls[1]![0].reasoning_effort).toBe('none');
    // Remembered for the model: the next call sends the substitute directly.
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2]![0].reasoning_effort).toBe('none');
  });

  it('walks the substitutes in order and drops the parameter only when none is accepted', async () => {
    const reject = (): OpenAI.BadRequestError =>
      unsupportedParamError('reasoning_effort', "'reasoning_effort' is not supported");
    mockCreate
      .mockRejectedValueOnce(reject())
      .mockRejectedValueOnce(reject())
      .mockRejectedValueOnce(reject())
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'compat' }));

    await provider.call({ ...BASE_REQUEST, model: 'compat', reasoningEffort: 'minimal' });

    expect(mockCreate.mock.calls.map((c) => c[0].reasoning_effort)).toEqual([
      'minimal',
      'none',
      'low',
      undefined,
    ]);
  });

  it('keeps substitutions per requested value', async () => {
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError('reasoning_effort', "'reasoning_effort' is not supported"),
      )
      .mockResolvedValue(makeOpenAIResponse({ model: 'gpt-5' }));

    await provider.call({ ...BASE_REQUEST, model: 'gpt-5', reasoningEffort: 'none' });
    await provider.call({ ...BASE_REQUEST, model: 'gpt-5', reasoningEffort: 'low' });

    expect(mockCreate.mock.calls[1]![0].reasoning_effort).toBe('minimal');
    // 'low' was never rejected: sent as requested.
    expect(mockCreate.mock.calls[2]![0].reasoning_effort).toBe('low');
  });

  it('falls back to legacy max_tokens only if the endpoint rejects max_completion_tokens', async () => {
    // Simulates a non-official endpoint (self-hosted proxy, old Azure apiVersion)
    // that hasn't implemented the modern parameter yet.
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError(
          'max_completion_tokens',
          'Unrecognized request argument supplied: max_completion_tokens',
        ),
      )
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-4o' }));

    const res = await provider.call({ ...BASE_REQUEST, maxTokens: 4096 });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(4096);
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBeUndefined();
    expect(mockCreate.mock.calls[1]![0].max_tokens).toBe(4096);
    expect(mockCreate.mock.calls[1]![0].max_completion_tokens).toBeUndefined();
    expect(res.provider).toBe('openai');
  });

  it('remembers the legacy max_tokens fallback for later calls to the same model', async () => {
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError('max_completion_tokens', 'Unrecognized request argument'),
      )
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-4o' }))
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-4o' }));

    await provider.call({ ...BASE_REQUEST, maxTokens: 4096 });
    await provider.call({ ...BASE_REQUEST, maxTokens: 2048 });

    // First call: 2 attempts (fail, then succeed). Second call: 1 attempt (cached quirk).
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2]![0].max_tokens).toBe(2048);
    expect(mockCreate.mock.calls[2]![0].max_completion_tokens).toBeUndefined();
  });

  it('retries without temperature when the model only supports the default value', async () => {
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError(
          'temperature',
          "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
        ),
      )
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-5' }));

    const res = await provider.call({ ...BASE_REQUEST, model: 'gpt-5', temperature: 0.1 });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0.1);
    expect(mockCreate.mock.calls[1]![0].temperature).toBeUndefined();
    expect(res.provider).toBe('openai');
  });

  it('recovers from both max_completion_tokens and temperature being rejected in the same call', async () => {
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError('max_completion_tokens', 'Unrecognized request argument'),
      )
      .mockRejectedValueOnce(
        unsupportedParamError('temperature', 'Only the default (1) value is supported'),
      )
      .mockResolvedValueOnce(makeOpenAIResponse({ model: 'gpt-5' }));

    const res = await provider.call({
      ...BASE_REQUEST,
      model: 'gpt-5',
      maxTokens: 4096,
      temperature: 0.1,
    });

    expect(mockCreate).toHaveBeenCalledTimes(3);
    const finalCall = mockCreate.mock.calls[2]![0];
    expect(finalCall.max_tokens).toBe(4096);
    expect(finalCall.max_completion_tokens).toBeUndefined();
    expect(finalCall.temperature).toBeUndefined();
    expect(res.provider).toBe('openai');
  });

  it('does not retry or swallow unrelated 400 errors', async () => {
    const err = new OpenAI.BadRequestError(
      400,
      { error: { type: 'invalid_request_error', message: 'model not found' } },
      'model not found',
      new Headers(),
    );
    mockCreate.mockRejectedValue(err);

    await expect(provider.call({ ...BASE_REQUEST, maxTokens: 100 })).rejects.toThrow(ProviderError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting known relaxations and surfaces the last error', async () => {
    // Simulate an endpoint that keeps rejecting parameters — should not loop
    // forever; must still make progress via distinct params each time.
    mockCreate
      .mockRejectedValueOnce(
        unsupportedParamError('max_completion_tokens', 'Unrecognized request argument'),
      )
      .mockRejectedValueOnce(
        unsupportedParamError('temperature', 'Only the default (1) value is supported'),
      )
      .mockRejectedValueOnce(unsupportedParamError('top_p', "Unsupported parameter: 'top_p'"));

    await expect(
      provider.call({ ...BASE_REQUEST, model: 'gpt-5', maxTokens: 4096, temperature: 0.1 }),
    ).rejects.toThrow(ProviderError);
    // 2 relaxations allowed (max_completion_tokens, temperature) => 3 attempts, then give up.
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('leaves temperature unchanged when the endpoint accepts it (no retry)', async () => {
    await provider.call({ ...BASE_REQUEST, model: 'gpt-4o', maxTokens: 512, temperature: 0.5 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(512);
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('wraps OpenAI.APIError into ProviderError', async () => {
    const apiErr = new OpenAI.AuthenticationError(
      401,
      { error: { type: 'invalid_request_error', message: 'Invalid API key' } },
      'Invalid API key',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    await expect(provider.call(BASE_REQUEST)).rejects.toThrow(ProviderError);
  });

  it('ProviderError carries provider name "openai"', async () => {
    const apiErr = new OpenAI.AuthenticationError(
      401,
      { error: { type: 'invalid_request_error', message: 'Bad key' } },
      'Bad key',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    const err = await provider.call(BASE_REQUEST).catch((e) => e as ProviderError);
    expect(err.provider).toBe('openai');
  });

  it('ProviderError carries the HTTP status code', async () => {
    const apiErr = new OpenAI.RateLimitError(
      429,
      { error: { type: 'rate_limit_error', message: 'Too many requests' } },
      'Too many requests',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    const err = await provider.call(BASE_REQUEST).catch((e) => e as ProviderError);
    expect(err.statusCode).toBe(429);
  });

  it('rethrows non-API errors unchanged', async () => {
    mockCreate.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(provider.call(BASE_REQUEST)).rejects.toThrow('ECONNREFUSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validate()
// ─────────────────────────────────────────────────────────────────────────────

describe('validate()', () => {
  it('reports ok when models.list() succeeds', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [{ id: 'gpt-4o' }] });
    const p = new OpenAIProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    expect(await p.validate()).toEqual({ ok: true });
  });

  it('reports the reason (does not throw) when models.list() fails', async () => {
    const mockList = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    const p = new OpenAIProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    expect(await p.validate()).toEqual({ ok: false, error: 'Unauthorized' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listModels()
// ─────────────────────────────────────────────────────────────────────────────

describe('listModels()', () => {
  it('returns model IDs from the API response', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    const p = new OpenAIProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    expect(await p.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('returns fallback known models when API call fails', async () => {
    const mockList = vi.fn().mockRejectedValue(new Error('down'));
    const p = new OpenAIProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    const models = await p.listModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Azure OpenAI — config detection
// ─────────────────────────────────────────────────────────────────────────────

describe('Azure OpenAI', () => {
  it('can be created with Azure config and injected client', async () => {
    // When apiVersion is present the factory would use AzureOpenAI.
    // With injection we just verify the provider works correctly regardless.
    const azureCreate = vi.fn().mockResolvedValue(makeOpenAIResponse({ model: 'gpt-4o' }));
    const p = new OpenAIProvider(
      {
        apiKey: 'azure-key',
        baseURL: 'https://my-resource.openai.azure.com',
        apiVersion: '2024-02-01',
      },
      makeMockClient({ create: azureCreate }),
    );

    const res = await p.call(BASE_REQUEST);
    expect(res.provider).toBe('openai');
    expect(azureCreate).toHaveBeenCalledOnce();
  });

  it('passes the model (deployment name) to the Azure API', async () => {
    const azureCreate = vi.fn().mockResolvedValue(makeOpenAIResponse({ model: 'my-deployment' }));
    const p = new OpenAIProvider(
      { apiKey: 'k', baseURL: 'https://resource.openai.azure.com', apiVersion: '2024-02-01' },
      makeMockClient({ create: azureCreate }),
    );

    await p.call({ ...BASE_REQUEST, model: 'my-deployment' });
    expect(azureCreate.mock.calls[0]![0].model).toBe('my-deployment');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('provider.name is "openai"', () => {
    expect(provider.name).toBe('openai');
  });
});
