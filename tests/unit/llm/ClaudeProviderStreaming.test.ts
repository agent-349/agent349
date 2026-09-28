import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from '../../../src/llm/ClaudeProvider.js';
import type { LLMRequest } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return {
    messages: { create },
    models: { list: vi.fn() },
  } as unknown as Anthropic;
}

/** Yields a text-only streamed message (two deltas). */
async function* textStream(cacheRead = 0): AsyncGenerator<unknown> {
  yield {
    type: 'message_start',
    message: {
      id: 'msg_stream_1',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 120,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
      },
    },
  };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } };
  yield { type: 'content_block_stop', index: 0 };
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  };
  yield { type: 'message_stop' };
}

/** Yields a tool_use streamed message with argument JSON split across deltas. */
async function* toolStream(): AsyncGenerator<unknown> {
  yield {
    type: 'message_start',
    message: {
      id: 'msg_stream_2',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 50,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
  };
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"query":' },
  };
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"earnings"}' },
  };
  yield { type: 'content_block_stop', index: 0 };
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 12 },
  };
  yield { type: 'message_stop' };
}

const BASE_REQUEST: LLMRequest = {
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-sonnet-4-20250514',
};

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('ClaudeProvider — streaming', () => {
  it('forwards text deltas via onToken and assembles the full response', async () => {
    const create = vi.fn().mockImplementation(() => textStream());
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const deltas: string[] = [];
    const res = await provider.call({ ...BASE_REQUEST, onToken: (d) => deltas.push(d) });

    expect(deltas).toEqual(['Hello', ' world']);
    expect(res.content).toBe('Hello world');
    expect(res.stopReason).toBe('end');
    // stream: true is requested from the API.
    expect(create.mock.calls[0]![0].stream).toBe(true);
  });

  it('reports usage and streaming performance metrics', async () => {
    const create = vi.fn().mockImplementation(() => textStream());
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const res = await provider.call({ ...BASE_REQUEST, onToken: () => {} });

    expect(res.usage.inputTokens).toBe(120);
    expect(res.usage.outputTokens).toBe(7);
    expect(res.performance).toBeDefined();
    expect(res.performance?.streamOpenMs).toBeGreaterThanOrEqual(0);
    expect(res.performance?.visibleOutputTokens).toBe(7);
  });

  it('reconstructs tool calls from input_json_delta fragments', async () => {
    const create = vi.fn().mockImplementation(() => toolStream());
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const res = await provider.call({ ...BASE_REQUEST, onToken: () => {} });

    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]!.toolName).toBe('search');
    expect(res.toolCalls![0]!.input).toEqual({ query: 'earnings' });
    expect(res.provider).toBe('claude');
  });

  it('captures cache_read_input_tokens as performance.cachedInputTokens', async () => {
    const create = vi.fn().mockImplementation(() => textStream(45));
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const res = await provider.call({ ...BASE_REQUEST, onToken: () => {} });
    expect(res.performance?.cachedInputTokens).toBe(45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation + cache tokens (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

describe('ClaudeProvider — signal & cache (non-streaming)', () => {
  function makeMessage(cacheRead: number): Anthropic.Message {
    return {
      id: 'm',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
      },
    } as Anthropic.Message;
  }

  it('forwards the AbortSignal to the API options', async () => {
    const create = vi.fn().mockResolvedValue(makeMessage(0));
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));
    const controller = new AbortController();

    await provider.call({ ...BASE_REQUEST, signal: controller.signal });

    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it('captures cache_read tokens on a non-streaming response', async () => {
    const create = vi.fn().mockResolvedValue(makeMessage(30));
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const res = await provider.call(BASE_REQUEST);
    expect(res.performance?.cachedInputTokens).toBe(30);
  });

  it('maps stop_sequence to "end"', async () => {
    const msg = makeMessage(0);
    (msg as { stop_reason: string }).stop_reason = 'stop_sequence';
    const create = vi.fn().mockResolvedValue(msg);
    const provider = new ClaudeProvider({ apiKey: 'k' }, makeMockClient(create));

    const res = await provider.call(BASE_REQUEST);
    expect(res.stopReason).toBe('end');
  });

  it('uses the configured instance name as the provider identity', async () => {
    const create = vi.fn().mockResolvedValue(makeMessage(0));
    const provider = new ClaudeProvider(
      { name: 'claude-main', apiKey: 'k' },
      makeMockClient(create),
    );
    const res = await provider.call(BASE_REQUEST);
    expect(res.provider).toBe('claude-main');
  });
});
