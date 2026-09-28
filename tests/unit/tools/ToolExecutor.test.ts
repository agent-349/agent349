import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../../../src/tools/ToolRegistry.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { ToolNotFoundError } from '../../../src/errors/index.js';
import type { Tool, ExecutionContext, ToolResult, AgentEvent } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = {
  tenantId: 'acme',
  userId: 'u1',
  roles: ['viewer'],
  sessionId: 's1',
  agentId: 'agent-1',
  requestId: 'r1',
};

/** Any-schema tool: accepts anything, returns { success: true, data: input } */
function makeTool(name: string, overrides: Partial<Omit<Tool, 'name'>> = {}): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' },
    async execute(input): Promise<ToolResult> {
      return { success: true, data: input };
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state (reset per test)
// ─────────────────────────────────────────────────────────────────────────────

let registry: ToolRegistry;
let bus: EventBus;
let executor: ToolExecutor;

beforeEach(() => {
  registry = new ToolRegistry();
  bus = new EventBus();
  executor = new ToolExecutor(registry, bus, {
    defaultTimeoutMs: 5_000,
    defaultRetryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('tool resolution', () => {
  it('throws ToolNotFoundError when the tool is not registered', async () => {
    await expect(executor.execute('missing', {}, CTX)).rejects.toThrow(ToolNotFoundError);
  });

  it('thrown ToolNotFoundError carries the correct code and toolName', async () => {
    await expect(executor.execute('no.such.tool', {}, CTX)).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
      toolName: 'no.such.tool',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('input validation', () => {
  it('returns failed ToolResult when required property is missing', async () => {
    registry.register(
      makeTool('strict', {
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      }),
    );

    const result = await executor.execute('strict', {}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/validation/i);
  });

  it('returns failed ToolResult when property type is wrong', async () => {
    registry.register(
      makeTool('typed', {
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      }),
    );

    const result = await executor.execute('typed', { id: 42 }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/validation/i);
  });

  it('proceeds to execute when input satisfies the schema', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, data: 'ok' });
    registry.register(
      makeTool('valid', {
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        execute,
      }),
    );

    const result = await executor.execute('valid', { id: 'abc' }, CTX);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('always accepts input when inputSchema is open (no required, no additionalProperties)', async () => {
    registry.register(makeTool('open'));
    const result = await executor.execute('open', { anything: true }, CTX);
    expect(result.success).toBe(true);
  });

  it('validation failure emits tool.call.error and NOT tool.call.end', async () => {
    const errors: AgentEvent[] = [];
    const ends: AgentEvent[] = [];
    bus.on('tool.call.error', (e) => errors.push(e));
    bus.on('tool.call.end', (e) => ends.push(e));

    registry.register(
      makeTool('strict', {
        inputSchema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
      }),
    );
    await executor.execute('strict', {}, CTX);

    expect(errors).toHaveLength(1);
    expect(ends).toHaveLength(0);
    expect(errors[0]?.data.toolName).toBe('strict');
  });

  it('validation failure includes metadata.durationMs', async () => {
    registry.register(
      makeTool('typed', {
        inputSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
      }),
    );
    const result = await executor.execute('typed', {}, CTX);
    expect(result.metadata?.durationMs).toBeTypeOf('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Successful execution
// ─────────────────────────────────────────────────────────────────────────────

describe('successful execution', () => {
  it('returns the data produced by tool.execute()', async () => {
    registry.register(
      makeTool('echo', {
        execute: async (input: any) => ({ success: true, data: input }),
      }),
    );

    const result = await executor.execute('echo', { msg: 'hello' }, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ msg: 'hello' });
  });

  it('passes the ExecutionContext to tool.execute()', async () => {
    let capturedCtx: ExecutionContext | undefined;
    registry.register(
      makeTool('ctx-check', {
        execute: async (_input, ctx) => {
          capturedCtx = ctx;
          return { success: true };
        },
      }),
    );

    await executor.execute('ctx-check', {}, CTX);

    expect(capturedCtx).toBe(CTX);
  });

  it('result always includes metadata.durationMs >= 0', async () => {
    registry.register(makeTool('fast'));
    const result = await executor.execute('fast', {}, CTX);

    expect(result.metadata?.durationMs).toBeTypeOf('number');
    expect(result.metadata!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves tokensUsed from tool-returned metadata', async () => {
    registry.register(
      makeTool('llm-tool', {
        execute: async () => ({
          success: true,
          data: null,
          metadata: { durationMs: 0, tokensUsed: 42 },
        }),
      }),
    );

    const result = await executor.execute('llm-tool', {}, CTX);

    expect(result.metadata?.tokensUsed).toBe(42);
  });

  it('preserves cached flag from tool-returned metadata', async () => {
    registry.register(
      makeTool('cached-tool', {
        execute: async () => ({
          success: true,
          data: 'hit',
          metadata: { durationMs: 0, cached: true },
        }),
      }),
    );

    const result = await executor.execute('cached-tool', {}, CTX);

    expect(result.metadata?.cached).toBe(true);
  });

  it('passes through a tool-returned success:false without retrying', async () => {
    const execute = vi.fn().mockResolvedValue({ success: false, error: 'not found' });
    registry.register(
      makeTool('partial', {
        execute,
        retryPolicy: { maxRetries: 3, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const result = await executor.execute('partial', {}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
    expect(execute).toHaveBeenCalledTimes(1); // returned failure ≠ thrown error
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event emission
// ─────────────────────────────────────────────────────────────────────────────

describe('event emission', () => {
  it('emits tool.call.start before execute() is called', async () => {
    const starts: AgentEvent[] = [];
    let executeCalled = false;

    bus.on('tool.call.start', (e) => starts.push(e));
    registry.register(
      makeTool('t', {
        execute: async () => {
          executeCalled = true;
          return { success: true };
        },
      }),
    );

    expect(starts).toHaveLength(0);
    await executor.execute('t', {}, CTX);

    expect(starts).toHaveLength(1);
    expect(executeCalled).toBe(true);
    expect(starts[0]?.data.toolName).toBe('t');
  });

  it('emits tool.call.end with success:true on successful execution', async () => {
    const ends: AgentEvent[] = [];
    bus.on('tool.call.end', (e) => ends.push(e));
    registry.register(makeTool('t'));
    await executor.execute('t', {}, CTX);

    expect(ends).toHaveLength(1);
    expect(ends[0]?.data.success).toBe(true);
    expect(ends[0]?.data.durationMs).toBeTypeOf('number');
  });

  it('emits tool.call.end with success:false when tool returns failure', async () => {
    const ends: AgentEvent[] = [];
    bus.on('tool.call.end', (e) => ends.push(e));
    registry.register(makeTool('t', { execute: async () => ({ success: false, error: 'oops' }) }));
    await executor.execute('t', {}, CTX);

    expect(ends[0]?.data.success).toBe(false);
  });

  it('emits tool.call.error (not tool.call.end) when execute() throws', async () => {
    const ends: AgentEvent[] = [];
    const errors: AgentEvent[] = [];
    bus.on('tool.call.end', (e) => ends.push(e));
    bus.on('tool.call.error', (e) => errors.push(e));

    registry.register(
      makeTool('broken', {
        execute: async () => {
          throw new Error('boom');
        },
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );
    await executor.execute('broken', {}, CTX);

    expect(ends).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data.toolName).toBe('broken');
  });

  it('emits tool.call.start with input in the event data', async () => {
    const starts: AgentEvent[] = [];
    bus.on('tool.call.start', (e) => starts.push(e));
    registry.register(makeTool('t'));
    await executor.execute('t', { key: 'value' }, CTX);

    expect(starts[0]?.data.input).toEqual({ key: 'value' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry logic
// ─────────────────────────────────────────────────────────────────────────────

describe('retry logic', () => {
  it('retries up to maxRetries times and succeeds on the last attempt', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ success: true, data: 'recovered' });

    registry.register(
      makeTool('flaky', {
        execute,
        retryPolicy: { maxRetries: 2, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const result = await executor.execute('flaky', {}, CTX);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('returns failed ToolResult after all retries are exhausted', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('permanent failure'));

    registry.register(
      makeTool('broken', {
        execute,
        retryPolicy: { maxRetries: 2, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const result = await executor.execute('broken', {}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('permanent failure');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not retry when maxRetries is 0', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('boom'));

    registry.register(
      makeTool('no-retry', {
        execute,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    await executor.execute('no-retry', {}, CTX);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses executor default retry policy when tool has none', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('error'));

    // Executor configured with maxRetries:1
    executor = new ToolExecutor(registry, bus, {
      defaultRetryPolicy: { maxRetries: 1, backoffMs: 0, backoffMultiplier: 1 },
    });
    registry.register(makeTool('t', { execute }));

    await executor.execute('t', {}, CTX);

    expect(execute).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('tool retryPolicy overrides executor default', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('error'));

    // Executor has maxRetries:3 but tool overrides to maxRetries:1
    executor = new ToolExecutor(registry, bus, {
      defaultRetryPolicy: { maxRetries: 3, backoffMs: 0, backoffMultiplier: 1 },
    });
    registry.register(
      makeTool('t', {
        execute,
        retryPolicy: { maxRetries: 1, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    await executor.execute('t', {}, CTX);

    expect(execute).toHaveBeenCalledTimes(2); // 1 initial + 1 retry (tool wins)
  });

  it('applies exponential backoff delays between retries', async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue({ success: true, data: null });

    registry.register(
      makeTool('slow', {
        execute,
        // backoffMs:100, multiplier:2 → delays: 100ms, 200ms
        retryPolicy: { maxRetries: 2, backoffMs: 100, backoffMultiplier: 2 },
      }),
    );

    const promise = executor.execute('slow', {}, CTX);
    // Advance through first backoff (100 ms) and second (200 ms)
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retryableErrors filter
// ─────────────────────────────────────────────────────────────────────────────

describe('retryableErrors filter', () => {
  it('retries when the error message matches a pattern', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED connection reset'))
      .mockResolvedValue({ success: true, data: null });

    registry.register(
      makeTool('net', {
        execute,
        retryPolicy: {
          maxRetries: 1,
          backoffMs: 0,
          backoffMultiplier: 1,
          retryableErrors: ['connection'],
        },
      }),
    );

    const result = await executor.execute('net', {}, CTX);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when the error message matches none of the patterns', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('FATAL: disk full'));

    registry.register(
      makeTool('selective', {
        execute,
        retryPolicy: {
          maxRetries: 3,
          backoffMs: 0,
          backoffMultiplier: 1,
          retryableErrors: ['timeout', 'connection'],
        },
      }),
    );

    await executor.execute('selective', {}, CTX);

    expect(execute).toHaveBeenCalledTimes(1); // stopped immediately
  });

  it('retries all errors when retryableErrors is empty (default)', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('anything at all'))
      .mockResolvedValue({ success: true, data: null });

    registry.register(
      makeTool('catch-all', {
        execute,
        retryPolicy: { maxRetries: 1, backoffMs: 0, backoffMultiplier: 1 },
        // retryableErrors omitted → retry everything
      }),
    );

    const result = await executor.execute('catch-all', {}, CTX);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('timeout', () => {
  it('returns failed ToolResult when the tool exceeds its timeout', async () => {
    vi.useFakeTimers();

    registry.register(
      makeTool('hang', {
        execute: () =>
          new Promise<ToolResult>(() => {
            /* never resolves */
          }),
        timeout: 1_000,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const promise = executor.execute('hang', {}, CTX);
    await vi.advanceTimersByTimeAsync(1_001);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('1000');
  });

  it('emits tool.call.error on timeout', async () => {
    vi.useFakeTimers();
    const errors: AgentEvent[] = [];
    bus.on('tool.call.error', (e) => errors.push(e));

    registry.register(
      makeTool('hang', {
        execute: () =>
          new Promise<ToolResult>(() => {
            /* never resolves */
          }),
        timeout: 500,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const promise = executor.execute('hang', {}, CTX);
    await vi.advanceTimersByTimeAsync(501);
    await promise;

    expect(errors).toHaveLength(1);
    expect(errors[0]?.data.toolName).toBe('hang');
  });

  it('uses the tool-level timeout, not the executor default', async () => {
    vi.useFakeTimers();

    // Executor default is 5 s, tool overrides to 200 ms
    registry.register(
      makeTool('custom-timeout', {
        execute: () =>
          new Promise<ToolResult>(() => {
            /* never resolves */
          }),
        timeout: 200,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const promise = executor.execute('custom-timeout', {}, CTX);
    // Advancing 201 ms should be enough (tool timeout = 200 ms)
    await vi.advanceTimersByTimeAsync(201);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('200');
  });

  it('does not timeout when the tool finishes in time', async () => {
    vi.useFakeTimers();

    registry.register(
      makeTool('fast', {
        execute: async () => ({ success: true, data: 'done' }),
        timeout: 1_000,
      }),
    );

    const result = await executor.execute('fast', {}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toBe('done');
  });

  it('retries a timed-out tool when maxRetries > 0', async () => {
    vi.useFakeTimers();
    let calls = 0;

    registry.register(
      makeTool('slow-then-fast', {
        execute: async () => {
          calls++;
          if (calls === 1) {
            // First call: hang indefinitely so it times out
            await new Promise<void>(() => {
              /* never */
            });
          }
          return { success: true, data: 'second try' };
        },
        timeout: 100,
        retryPolicy: { maxRetries: 1, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const promise = executor.execute('slow-then-fast', {}, CTX);
    // Trigger first timeout, then let second attempt resolve normally
    await vi.advanceTimersByTimeAsync(101);
    // Run microtasks so the second attempt can complete
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });

  it('result includes metadata.durationMs on timeout', async () => {
    vi.useFakeTimers();

    registry.register(
      makeTool('hang', {
        execute: () =>
          new Promise<ToolResult>(() => {
            /* never resolves */
          }),
        timeout: 300,
        retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1 },
      }),
    );

    const promise = executor.execute('hang', {}, CTX);
    await vi.advanceTimersByTimeAsync(301);

    const result = await promise;
    expect(result.metadata?.durationMs).toBeTypeOf('number');
  });
});
