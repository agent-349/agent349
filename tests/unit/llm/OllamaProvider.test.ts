import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider } from '../../../src/llm/OllamaProvider.js';
import { ProviderError } from '../../../src/errors/index.js';
import type { LLMRequest, LLMMessage, ContentBlock } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface OllamaChatBody {
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown[];
  temperature?: number;
  options?: { num_predict: number };
}

interface MockOllamaResponse {
  model?: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function makeOllamaResponse(overrides: Partial<MockOllamaResponse> = {}): MockOllamaResponse {
  return {
    model: 'llama3',
    message: { role: 'assistant', content: 'Hello!', ...overrides.message },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 100,
    eval_count: 50,
    ...overrides,
  };
}

function makeMockFetch(response: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(response),
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'llama3',
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('call() — basic', () => {
  it('posts to /api/chat with stream: false', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body) as OllamaChatBody;
    expect(body.stream).toBe(false);
  });

  it('uses the configured baseUrl', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({ baseUrl: 'http://my-ollama:11434' }, mockFetch);

    await provider.call(makeRequest());

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://my-ollama:11434/api/chat');
  });

  it('strips trailing slash from baseUrl', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/' }, mockFetch);

    await provider.call(makeRequest());

    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://localhost:11434/api/chat');
  });

  it('injects systemPrompt as the first message with role "system"', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest({ systemPrompt: 'Be concise.' }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
  });

  it('passes the model correctly', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest({ model: 'mistral' }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.model).toBe('mistral');
  });

  it('passes temperature when provided', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest({ temperature: 0.7 }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.temperature).toBe(0.7);
  });

  it('omits temperature when not provided', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest());

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.temperature).toBeUndefined();
  });

  it('passes maxTokens as options.num_predict', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest({ maxTokens: 512 }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.options).toEqual({ num_predict: 512 });
  });

  it('sets provider to "ollama"', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.provider).toBe('ollama');
  });

  it('returns the model from the API response', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse({ model: 'codellama' }));
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest({ model: 'codellama' }));

    expect(response.model).toBe('codellama');
  });

  it('latencyMs is a non-negative number', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('tool translation', () => {
  it('wraps tools in OpenAI-compatible format with "parameters" key', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(
      makeRequest({
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      }),
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    });
  });

  it('omits tools when no tools are provided', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest());

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.tools).toBeUndefined();
  });

  it('omits tools when an empty array is provided', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    await provider.call(makeRequest({ tools: [] }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.tools).toBeUndefined();
  });
});

describe('response parsing — text', () => {
  it('extracts text content from message.content', async () => {
    const mockFetch = makeMockFetch(
      makeOllamaResponse({ message: { role: 'assistant', content: 'World!' } }),
    );
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.content).toBe('World!');
  });

  it('returns empty string when message.content is empty', async () => {
    const mockFetch = makeMockFetch(
      makeOllamaResponse({ message: { role: 'assistant', content: '' } }),
    );
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.content).toBe('');
  });
});

describe('response parsing — tool calls', () => {
  it('extracts a single tool call', async () => {
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search', arguments: { q: 'test' } } }],
      },
      done_reason: 'stop',
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]!.toolName).toBe('search');
    expect(response.toolCalls![0]!.input).toEqual({ q: 'test' });
  });

  it('generates a UUID as the tool call id', async () => {
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'fn', arguments: {} } }],
      },
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.toolCalls![0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('arguments are preserved as a plain object (not re-stringified)', async () => {
    const args = { city: 'Paris', units: 'metric' };
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'weather', arguments: args } }],
      },
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.toolCalls![0]!.input).toEqual(args);
  });

  it('extracts multiple tool calls', async () => {
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'fn1', arguments: { a: 1 } } },
          { function: { name: 'fn2', arguments: { b: 2 } } },
        ],
      },
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.toolCalls).toHaveLength(2);
  });

  it('toolCalls is undefined when no tool_calls in the response', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.toolCalls).toBeUndefined();
  });
});

describe('finish reason / stopReason mapping', () => {
  it('maps "stop" done_reason → "end"', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse({ done_reason: 'stop' }));
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.stopReason).toBe('end');
  });

  it('maps "length" done_reason → "max_tokens"', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse({ done_reason: 'length' }));
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.stopReason).toBe('max_tokens');
  });

  it('reports tool_use stopReason when tool_calls are present (even if done_reason is "stop")', async () => {
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'fn', arguments: {} } }],
      },
      done_reason: 'stop',
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.stopReason).toBe('tool_use');
  });
});

describe('usage', () => {
  it('maps prompt_eval_count → inputTokens and eval_count → outputTokens', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse({ prompt_eval_count: 200, eval_count: 80 }));
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.usage.inputTokens).toBe(200);
    expect(response.usage.outputTokens).toBe(80);
    expect(response.usage.totalTokens).toBe(280);
  });

  it('defaults to 0 tokens when counts are absent', async () => {
    const raw = makeOllamaResponse();
    delete (raw as Partial<typeof raw>).prompt_eval_count;
    delete (raw as Partial<typeof raw>).eval_count;
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.usage.inputTokens).toBe(0);
    expect(response.usage.outputTokens).toBe(0);
  });

  it('does not include a cost field (local model — no billing)', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.usage.cost).toBeUndefined();
  });
});

describe('contentBlocks', () => {
  it('includes a text block when content is non-empty', async () => {
    const mockFetch = makeMockFetch(
      makeOllamaResponse({ message: { role: 'assistant', content: 'Hello!' } }),
    );
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    expect(response.contentBlocks).toContainEqual({ type: 'text', text: 'Hello!' });
  });

  it('includes tool_use blocks for each tool call', async () => {
    const raw = makeOllamaResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'fn', arguments: { x: 1 } } }],
      },
    });
    const mockFetch = makeMockFetch(raw);
    const provider = new OllamaProvider({}, mockFetch);

    const response = await provider.call(makeRequest());

    const toolBlock = response.contentBlocks?.find((b) => b.type === 'tool_use');
    expect(toolBlock).toBeDefined();
    expect(toolBlock?.toolName).toBe('fn');
    expect(toolBlock?.input).toEqual({ x: 1 });
    // toolUseId must match the generated tool call id
    expect(toolBlock?.toolUseId).toBe(response.toolCalls![0]!.id);
  });
});

describe('message translation', () => {
  it('passes user string messages after the system message', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello!' }];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello!' });
  });

  it('skips system-role messages from the messages array', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 'hi' },
    ];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    // Only the injected system prompt + the user message
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('converts tool result message to role:"tool" with tool_call_id', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const messages: LLMMessage[] = [
      { role: 'tool', content: '{"balance":100}', toolCallId: 'tc-abc' },
    ];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    expect(body.messages[1]).toEqual({
      role: 'tool',
      content: '{"balance":100}',
      tool_call_id: 'tc-abc',
    });
  });

  it('keeps each tool result as a separate message (no grouping)', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const messages: LLMMessage[] = [
      { role: 'tool', content: 'result1', toolCallId: 'tc-1' },
      { role: 'tool', content: 'result2', toolCallId: 'tc-2' },
    ];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    // system + 2 separate tool messages
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toMatchObject({ role: 'tool', content: 'result1' });
    expect(body.messages[2]).toMatchObject({ role: 'tool', content: 'result2' });
  });

  it('converts assistant ContentBlock[] to Ollama tool_calls format with object arguments', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const blocks: ContentBlock[] = [
      { type: 'tool_use', toolUseId: 'uid-1', toolName: 'search', input: { q: 'hello' } },
    ];
    const messages: LLMMessage[] = [{ role: 'assistant', content: blocks }];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    const assistantMsg = body.messages[1] as { role: string; tool_calls: unknown[] };
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'uid-1',
      type: 'function',
      function: { name: 'search', arguments: { q: 'hello' } },
    });
  });

  it('preserves text content alongside tool_calls in ContentBlock[] assistant messages', async () => {
    const mockFetch = makeMockFetch(makeOllamaResponse());
    const provider = new OllamaProvider({}, mockFetch);
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Searching...' },
      { type: 'tool_use', toolUseId: 'uid-2', toolName: 'fn', input: {} },
    ];
    const messages: LLMMessage[] = [{ role: 'assistant', content: blocks }];

    await provider.call(makeRequest({ messages }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    ) as OllamaChatBody;
    const assistantMsg = body.messages[1] as { content: string; tool_calls: unknown[] };
    expect(assistantMsg.content).toBe('Searching...');
    expect(assistantMsg.tool_calls).toHaveLength(1);
  });
});

describe('error handling', () => {
  it('wraps HTTP error into ProviderError', async () => {
    const mockFetch = makeMockFetch({ error: 'model not found' }, false, 404);
    const provider = new OllamaProvider({}, mockFetch);

    await expect(provider.call(makeRequest())).rejects.toBeInstanceOf(ProviderError);
  });

  it('ProviderError carries provider name "ollama"', async () => {
    const mockFetch = makeMockFetch(null, false, 500);
    const provider = new OllamaProvider({}, mockFetch);

    const err = await provider.call(makeRequest()).catch((e: unknown) => e);
    expect((err as ProviderError).provider).toBe('ollama');
  });

  it('wraps network error (fetch throws) into ProviderError', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OllamaProvider({}, mockFetch);

    const err = await provider.call(makeRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain('ECONNREFUSED');
  });

  it('throws ProviderError on timeout', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 120_000);
        }),
    );
    const provider = new OllamaProvider({ timeoutMs: 100 }, mockFetch);

    try {
      const callPromise = provider.call(makeRequest());
      // Attach the expectation first: the call rejects while time is advanced
      // below, and a rejection with no handler yet is reported as unhandled.
      const rejection = expect(callPromise).rejects.toBeInstanceOf(ProviderError);
      // Message translation is async (a content block may be a file on disk), so
      // let the microtask queue drain and arm the timeout before advancing time.
      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('validate()', () => {
  it('returns true when /api/tags responds with ok:true', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const provider = new OllamaProvider({}, mockFetch);

    expect(await provider.validate()).toEqual({ ok: true });
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain('/api/tags');
  });

  it('reports the HTTP status when /api/tags responds with ok:false', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const provider = new OllamaProvider({}, mockFetch);

    const probe = await provider.validate();
    expect(probe.ok).toBe(false);
    // A 404 (wrong base URL) and a refused connection are different incidents.
    expect(probe.error).toContain('404');
  });

  it('reports the network error when fetch throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OllamaProvider({}, mockFetch);

    expect(await provider.validate()).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('listModels()', () => {
  it('returns model names from /api/tags', async () => {
    const tagsResponse = {
      models: [{ name: 'llama3' }, { name: 'mistral' }, { name: 'codellama' }],
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(tagsResponse),
    });
    const provider = new OllamaProvider({}, mockFetch);

    const models = await provider.listModels();

    expect(models).toEqual(['llama3', 'mistral', 'codellama']);
  });

  it('returns an empty array when /api/tags fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const provider = new OllamaProvider({}, mockFetch);

    expect(await provider.listModels()).toEqual([]);
  });
});

describe('identity', () => {
  it('provider.name is "ollama"', () => {
    expect(new OllamaProvider().name).toBe('ollama');
  });
});
