import { describe, it, expect, beforeEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from '../../../src/llm/ClaudeProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { LLMMessage, LLMRequest } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal mock Anthropic.Message (Claude API response). */
function makeClaudeMessage(
  overrides: Partial<{
    id: string;
    content: Anthropic.ContentBlock[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  }> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    model: 'claude-sonnet-4-20250514',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  } as Anthropic.Message;
}

/** Build a mock Anthropic client with injectable fns. */
function makeMockClient(
  overrides: {
    create?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    messages: { create: overrides.create ?? vi.fn() },
    models: { list: overrides.list ?? vi.fn() },
  } as unknown as Anthropic;
}

/** Standard LLM request fixture. */
const BASE_REQUEST: LLMRequest = {
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-sonnet-4-20250514',
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let mockCreate: ReturnType<typeof vi.fn>;
let provider: ClaudeProvider;

beforeEach(() => {
  mockCreate = vi.fn().mockResolvedValue(makeClaudeMessage());
  provider = new ClaudeProvider({ apiKey: 'test-key' }, makeMockClient({ create: mockCreate }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic call() behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('call() — basic', () => {
  it('calls the Anthropic messages.create API', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('passes the correct model to the API', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].model).toBe('claude-sonnet-4-20250514');
  });

  it('passes the system prompt to the API', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].system).toBe('You are helpful.');
  });

  it('passes max_tokens (default 4096) to the API', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(4_096);
  });

  it('respects a custom maxTokens from the request', async () => {
    await provider.call({ ...BASE_REQUEST, maxTokens: 1024 });
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(1_024);
  });

  it('passes temperature when provided', async () => {
    await provider.call({ ...BASE_REQUEST, temperature: 0.7 });
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0.7);
  });

  it('omits temperature when not provided', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].temperature).toBeUndefined();
  });

  it('sets provider to "claude" in the response', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.provider).toBe('claude');
  });

  it('returns the model from the Claude response (not the request)', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ model: 'claude-sonnet-4-20250514-v1' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.model).toBe('claude-sonnet-4-20250514-v1');
  });

  it('latencyMs is a non-negative number', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool translation: SDK ToolDescriptor → Claude input_schema
// ─────────────────────────────────────────────────────────────────────────────

describe('tool translation', () => {
  it('converts inputSchema to input_schema', async () => {
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
    expect(tools[0].input_schema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(tools[0].inputSchema).toBeUndefined(); // SDK field must NOT bleed through
  });

  it('preserves tool name and description', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [{ name: 'my-tool', description: 'Does stuff', inputSchema: { type: 'object' } }],
    });

    const tool = mockCreate.mock.calls[0]![0].tools[0];
    expect(tool.name).toBe('my-tool');
    expect(tool.description).toBe('Does stuff');
  });

  it('passes all tools when multiple are provided', async () => {
    await provider.call({
      ...BASE_REQUEST,
      tools: [
        { name: 'tool-a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'tool-b', description: 'B', inputSchema: { type: 'object' } },
      ],
    });

    expect(mockCreate.mock.calls[0]![0].tools).toHaveLength(2);
  });

  it('omits tools from the API call when none are provided', async () => {
    await provider.call(BASE_REQUEST);
    expect(mockCreate.mock.calls[0]![0].tools).toBeUndefined();
  });

  it('omits tools from the API call when an empty array is provided', async () => {
    await provider.call({ ...BASE_REQUEST, tools: [] });
    expect(mockCreate.mock.calls[0]![0].tools).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing: text content
// ─────────────────────────────────────────────────────────────────────────────

describe('response parsing — text', () => {
  it('extracts text from a text block', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({ content: [{ type: 'text', text: 'Hello world' }] }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('Hello world');
  });

  it('joins multiple text blocks', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [
          { type: 'text', text: 'Part A. ' },
          { type: 'text', text: 'Part B.' },
        ],
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('Part A. Part B.');
  });

  it('returns empty string when there are no text blocks', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: {} }],
        stop_reason: 'tool_use',
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing: tool calls
// ─────────────────────────────────────────────────────────────────────────────

describe('response parsing — tool calls', () => {
  it('extracts a single tool call', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'test' } }],
        stop_reason: 'tool_use',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]!.id).toBe('tu1');
    expect(res.toolCalls![0]!.toolName).toBe('search');
    expect(res.toolCalls![0]!.input).toEqual({ q: 'test' });
  });

  it('extracts multiple tool calls', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [
          { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'a' } },
          { type: 'tool_use', id: 'tu2', name: 'calc', input: { expr: '1+1' } },
        ],
        stop_reason: 'tool_use',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls![0]!.toolName).toBe('search');
    expect(res.toolCalls![1]!.toolName).toBe('calc');
  });

  it('toolCalls is undefined when no tool_use blocks are present', async () => {
    const res = await provider.call(BASE_REQUEST);
    expect(res.toolCalls).toBeUndefined();
  });

  it('handles mixed text + tool_use response', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [
          { type: 'text', text: 'Let me search.' },
          { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'test' } },
        ],
        stop_reason: 'tool_use',
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.content).toBe('Let me search.');
    expect(res.toolCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing: stop reason mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('stop reason mapping', () => {
  it('maps end_turn → "end"', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ stop_reason: 'end_turn' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.stopReason).toBe('end');
  });

  it('maps tool_use → "tool_use"', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 't', input: {} }],
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.stopReason).toBe('tool_use');
  });

  it('maps max_tokens → "max_tokens"', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ stop_reason: 'max_tokens' }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.stopReason).toBe('max_tokens');
  });

  it('maps null stop_reason → "end"', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ stop_reason: null }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.stopReason).toBe('end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing: usage & cost
// ─────────────────────────────────────────────────────────────────────────────

describe('usage and cost', () => {
  it('populates inputTokens, outputTokens, totalTokens', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    expect(res.usage.inputTokens).toBe(200);
    expect(res.usage.outputTokens).toBe(80);
    expect(res.usage.totalTokens).toBe(280);
  });

  it('calculates cost for claude-sonnet-4-20250514 (0.003/0.015 per 1K tokens)', async () => {
    // 1000 input tokens + 1000 output tokens
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    // cost = (1000 * 0.003 + 1000 * 0.015) / 1000 = 0.018
    expect(res.usage.cost).toBeCloseTo(0.018);
  });

  it.each([
    // [model reported by the API, expected cost for 1 000 input + 1 000 output tokens]
    ['claude-opus-5', 0.03],
    ['claude-sonnet-5', 0.012],
    ['claude-fable-5-1', 0.06],
    ['claude-haiku-4-5-20251001', 0.006], // dated snapshot priced through its alias
  ])('prices current model %s from the built-in table', async (model, expected) => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        model,
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.usage.cost).toBeCloseTo(expected);
  });

  it('returns undefined cost for an unknown model', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ model: 'unknown-model-xyz' }));

    const p = new ClaudeProvider(
      { apiKey: 'k', pricing: {} },
      makeMockClient({ create: mockCreate }),
    );
    const res = await p.call(BASE_REQUEST);
    expect(res.usage.cost).toBeUndefined();
  });

  it('allows custom pricing via config', async () => {
    const customPricing = { 'my-model': { input: 0.001, output: 0.002 } };
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        model: 'my-model',
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    const p = new ClaudeProvider(
      { apiKey: 'k', pricing: customPricing },
      makeMockClient({ create: mockCreate }),
    );
    const res = await p.call(BASE_REQUEST);
    // cost = (1000 * 0.001 + 1000 * 0.002) / 1000 = 0.003
    expect(res.usage.cost).toBeCloseTo(0.003);
  });

  it('matches a model by prefix when exact key is absent', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        model: 'claude-sonnet-4-20250514-preview',
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );

    const res = await provider.call(BASE_REQUEST);
    // Should still find 'claude-sonnet-4-20250514' pricing via prefix match
    expect(res.usage.cost).toBeCloseTo(0.003); // 1000 * 0.003 / 1000
  });

  it('merges config.pricing on top of the built-in defaults instead of replacing them', async () => {
    // Only overriding one model — 'claude-opus-4-20250514' (untouched) must
    // still resolve from the built-in table, since re-listing every model on
    // every price change would defeat the point of a small override.
    const p = new ClaudeProvider(
      { apiKey: 'k', pricing: { 'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 } } },
      makeMockClient({ create: mockCreate }),
    );

    mockCreate.mockResolvedValueOnce(
      makeClaudeMessage({
        model: 'claude-opus-4-20250514',
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const opusRes = await p.call({ ...BASE_REQUEST, model: 'claude-opus-4-20250514' });
    expect(opusRes.usage.cost).toBeCloseTo(0.015); // untouched built-in default

    mockCreate.mockResolvedValueOnce(
      makeClaudeMessage({
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const haikuRes = await p.call({ ...BASE_REQUEST, model: 'claude-haiku-4-5-20251001' });
    expect(haikuRes.usage.cost).toBeCloseTo(0.001); // overridden value, not the built-in 0.0008
  });

  it('prefers the longest matching prefix when two configured keys both match', async () => {
    // 'claude-haiku-4' and 'claude-haiku-4-5' both prefix-match
    // 'claude-haiku-4-5-20251001' — the more specific key must win regardless
    // of which one was inserted first in the pricing object.
    const p = new ClaudeProvider(
      {
        apiKey: 'k',
        pricing: {
          'claude-haiku-4': { input: 0.999, output: 0.999 }, // deliberately wrong if picked
          'claude-haiku-4-5': { input: 0.001, output: 0.002 },
        },
      },
      makeMockClient({ create: mockCreate }),
    );

    mockCreate.mockResolvedValueOnce(
      makeClaudeMessage({
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 1000,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const res = await p.call(BASE_REQUEST);
    // cost = (1000*0.001 + 1000*0.002)/1000 = 0.003 — the 'claude-haiku-4' entry must NOT win.
    expect(res.usage.cost).toBeCloseTo(0.003);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// contentBlocks round-trip preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('contentBlocks (round-trip preservation)', () => {
  it('populates contentBlocks with text blocks', async () => {
    mockCreate.mockResolvedValue(makeClaudeMessage({ content: [{ type: 'text', text: 'Hi' }] }));
    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('populates contentBlocks with tool_use blocks', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [{ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } }],
        stop_reason: 'tool_use',
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toEqual([
      { type: 'tool_use', toolUseId: 'tu1', toolName: 'search', input: { q: 'x' } },
    ]);
  });

  it('contentBlocks preserves both text and tool_use when mixed', async () => {
    mockCreate.mockResolvedValue(
      makeClaudeMessage({
        content: [
          { type: 'text', text: 'Searching...' },
          { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.contentBlocks).toHaveLength(2);
    expect(res.contentBlocks![0]).toMatchObject({ type: 'text', text: 'Searching...' });
    expect(res.contentBlocks![1]).toMatchObject({ type: 'tool_use', toolUseId: 'tu1' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Message translation: SDK → Claude format
// ─────────────────────────────────────────────────────────────────────────────

describe('message translation', () => {
  it('passes user string messages unchanged', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [{ role: 'user', content: 'Hello!' }],
    });
    const messages = mockCreate.mock.calls[0]![0].messages;
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello!' });
  });

  it('passes assistant string messages unchanged', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello back' },
        { role: 'user', content: 'Thanks' },
      ],
    });
    const messages = mockCreate.mock.calls[0]![0].messages;
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello back' });
  });

  it('converts a tool message to a user turn with tool_result block', async () => {
    const toolMsg: LLMMessage = {
      role: 'tool',
      content: '{"balance": 100}',
      toolCallId: 'tu1',
      name: 'getBalance',
    };

    await provider.call({
      ...BASE_REQUEST,
      messages: [{ role: 'user', content: 'Check balance' }, toolMsg],
    });

    const messages = mockCreate.mock.calls[0]![0].messages;
    const toolTurn = messages.find(
      (m: Anthropic.MessageParam) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(toolTurn).toBeDefined();
    expect(toolTurn.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: '{"balance": 100}',
    });
  });

  it('groups consecutive tool messages into a single user turn', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'tool', content: 'result-a', toolCallId: 'tu1', name: 'toolA' },
        { role: 'tool', content: 'result-b', toolCallId: 'tu2', name: 'toolB' },
      ],
    });

    const messages = mockCreate.mock.calls[0]![0].messages;
    const toolTurns = messages.filter(
      (m: Anthropic.MessageParam) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0].content).toHaveLength(2);
    expect(toolTurns[0].content[0].tool_use_id).toBe('tu1');
    expect(toolTurns[0].content[1].tool_use_id).toBe('tu2');
  });

  it('converts assistant ContentBlock[] (tool_use) to Claude tool_use format', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', toolUseId: 'tu1', toolName: 'search', input: { q: 'x' } }],
        },
        { role: 'tool', content: 'results', toolCallId: 'tu1', name: 'search' },
      ],
    });

    const messages = mockCreate.mock.calls[0]![0].messages;
    const assistantTurn = messages.find(
      (m: Anthropic.MessageParam) => m.role === 'assistant' && Array.isArray(m.content),
    );
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn.content[0]).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'search',
      input: { q: 'x' },
    });
  });

  it('skips system-role messages (passed via top-level system param)', async () => {
    await provider.call({
      ...BASE_REQUEST,
      messages: [
        { role: 'system', content: 'System instruction' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const messages = mockCreate.mock.calls[0]![0].messages;
    expect(messages.every((m: Anthropic.MessageParam) => m.role !== 'system')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('wraps Anthropic.APIError into ProviderError', async () => {
    const apiErr = new Anthropic.AuthenticationError(
      401,
      { error: { type: 'authentication_error', message: 'Invalid API key' } },
      'Invalid API key',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    await expect(provider.call(BASE_REQUEST)).rejects.toThrow(ProviderError);
  });

  it('ProviderError carries the provider name "claude"', async () => {
    const apiErr = new Anthropic.AuthenticationError(
      401,
      { error: { type: 'authentication_error', message: 'Bad key' } },
      'Bad key',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    const err = await provider.call(BASE_REQUEST).catch((e) => e as ProviderError);
    expect(err.provider).toBe('claude');
  });

  it('ProviderError carries the HTTP status code', async () => {
    const apiErr = new Anthropic.RateLimitError(
      429,
      { error: { type: 'rate_limit_error', message: 'Too many requests' } },
      'Too many requests',
      new Headers(),
    );
    mockCreate.mockRejectedValue(apiErr);

    const err = await provider.call(BASE_REQUEST).catch((e) => e as ProviderError);
    expect(err.statusCode).toBe(429);
  });

  it('rethrows non-API errors as-is', async () => {
    const networkErr = new Error('ECONNREFUSED');
    mockCreate.mockRejectedValue(networkErr);

    await expect(provider.call(BASE_REQUEST)).rejects.toThrow('ECONNREFUSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validate()
// ─────────────────────────────────────────────────────────────────────────────

describe('validate()', () => {
  it('reports ok when models.list() succeeds', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [{ id: 'claude-sonnet-4-20250514' }] });
    const p = new ClaudeProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    expect(await p.validate()).toEqual({ ok: true });
  });

  it('reports the reason (does not throw) when models.list() fails', async () => {
    const mockList = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    const p = new ClaudeProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    // An expired key and an unreachable host need different responses, so the
    // probe carries the cause instead of collapsing it to false.
    expect(await p.validate()).toEqual({ ok: false, error: 'Unauthorized' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listModels()
// ─────────────────────────────────────────────────────────────────────────────

describe('listModels()', () => {
  it('returns model IDs from the API response', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-opus-4-20250514' }],
    });
    const p = new ClaudeProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    const models = await p.listModels();
    expect(models).toEqual(['claude-sonnet-4-20250514', 'claude-opus-4-20250514']);
  });

  it('returns fallback known models when API call fails', async () => {
    const mockList = vi.fn().mockRejectedValue(new Error('down'));
    const p = new ClaudeProvider({ apiKey: 'k' }, makeMockClient({ list: mockList }));
    const models = await p.listModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity & name
// ─────────────────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('provider.name is "claude"', () => {
    expect(provider.name).toBe('claude');
  });
});
