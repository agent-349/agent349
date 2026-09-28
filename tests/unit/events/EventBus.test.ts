import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/events/EventBus.js';
import type { AgentEvent } from '../../../src/types/index.js';

// Helper: collect emitted AgentEvents from a handler into an array.
function collect(bus: EventBus, event: string): AgentEvent[] {
  const received: AgentEvent[] = [];
  bus.on(event, (e) => received.push(e));
  return received;
}

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic on / emit / off
// ─────────────────────────────────────────────────────────────────────────────

describe('on / emit / off', () => {
  it('calls handler when the exact event is emitted', () => {
    const handler = vi.fn();
    bus.on('tool.call.end', handler);
    bus.emit('tool.call.end', { toolName: 'rag.search' });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('passes an AgentEvent envelope to the handler', () => {
    const received = collect(bus, 'llm.call.end');
    bus.emit('llm.call.end', { latencyMs: 300 });

    const event = received[0];
    expect(event?.type).toBe('llm.call.end');
    expect(event?.data).toEqual({ latencyMs: 300 });
    expect(event?.timestamp).toBeInstanceOf(Date);
  });

  it('attaches a timestamp automatically', () => {
    const before = new Date();
    const received = collect(bus, 'agent.loop.start');
    bus.emit('agent.loop.start', {});
    const after = new Date();

    const ts = received[0]?.timestamp;
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('does not call handler for a different event', () => {
    const handler = vi.fn();
    bus.on('tool.call.end', handler);
    bus.emit('tool.call.start', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls multiple handlers registered on the same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('agent.loop.end', h1);
    bus.on('agent.loop.end', h2);
    bus.emit('agent.loop.end', { iterations: 3 });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('stops calling handler after off()', () => {
    const handler = vi.fn();
    bus.on('tool.call.start', handler);
    bus.emit('tool.call.start', {});
    bus.off('tool.call.start', handler);
    bus.emit('tool.call.start', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('on() returns this for chaining', () => {
    expect(bus.on('x', vi.fn())).toBe(bus);
  });

  it('off() returns this for chaining', () => {
    const h = vi.fn();
    bus.on('x', h);
    expect(bus.off('x', h)).toBe(bus);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wildcard subscriptions
// ─────────────────────────────────────────────────────────────────────────────

describe('wildcard on()', () => {
  it("'tool.*' matches tool.call.start", () => {
    const received = collect(bus, 'tool.*');
    bus.emit('tool.call.start', { toolName: 'rag.search' });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('tool.call.start');
  });

  it("'tool.*' matches tool.call.end", () => {
    const received = collect(bus, 'tool.*');
    bus.emit('tool.call.end', { toolName: 'rag.search', success: true });

    expect(received).toHaveLength(1);
  });

  it("'tool.*' matches tool.call.error", () => {
    const received = collect(bus, 'tool.*');
    bus.emit('tool.call.error', { toolName: 'hr.getEmployee', error: 'timeout' });

    expect(received).toHaveLength(1);
  });

  it("'tool.*' does not match llm.call.end", () => {
    const received = collect(bus, 'tool.*');
    bus.emit('llm.call.end', { latencyMs: 200 });

    expect(received).toHaveLength(0);
  });

  it("'llm.*' matches all llm events", () => {
    const received = collect(bus, 'llm.*');
    bus.emit('llm.call.start', { iteration: 1 });
    bus.emit('llm.call.end', { latencyMs: 150 });
    bus.emit('llm.call.error', { error: 'timeout', provider: 'claude' });
    bus.emit('llm.fallback', { from: 'claude', to: 'openai' });

    expect(received).toHaveLength(4);
  });

  it("'*' matches every event", () => {
    const received = collect(bus, '*');
    bus.emit('agent.loop.start', {});
    bus.emit('tool.call.end', {});
    bus.emit('llm.fallback', {});

    expect(received).toHaveLength(3);
  });

  it("'tool.call.*' matches tool.call.start and tool.call.end but not tool.other'", () => {
    const received = collect(bus, 'tool.call.*');
    bus.emit('tool.call.start', {});
    bus.emit('tool.call.end', {});

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.type)).toEqual(['tool.call.start', 'tool.call.end']);
  });

  it('wildcard and exact handlers both fire for the same event', () => {
    const exact = vi.fn();
    const wildcard = vi.fn();
    bus.on('tool.call.end', exact);
    bus.on('tool.*', wildcard);
    bus.emit('tool.call.end', {});

    expect(exact).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });

  it('does not call wildcard handler after off(pattern, handler)', () => {
    const handler = vi.fn();
    bus.on('tool.*', handler);
    bus.emit('tool.call.start', {});
    bus.off('tool.*', handler);
    bus.emit('tool.call.end', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('removing one wildcard handler does not affect another on the same pattern', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('tool.*', h1);
    bus.on('tool.*', h2);
    bus.off('tool.*', h1);
    bus.emit('tool.call.end', {});

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('wildcard AgentEvent envelope has type set to the emitted event name', () => {
    const received = collect(bus, 'tool.*');
    bus.emit('tool.call.end', { toolName: 'x' });

    expect(received[0]?.type).toBe('tool.call.end');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// once()
// ─────────────────────────────────────────────────────────────────────────────

describe('once()', () => {
  it('fires exactly once for an exact event', () => {
    const handler = vi.fn();
    bus.once('agent.loop.end', handler);
    bus.emit('agent.loop.end', { iterations: 1 });
    bus.emit('agent.loop.end', { iterations: 2 });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].data).toEqual({ iterations: 1 });
  });

  it('does not fire if the event is never emitted', () => {
    const handler = vi.fn();
    bus.once('never.emitted', handler);
    bus.emit('something.else', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('can be removed with off() before it fires', () => {
    const handler = vi.fn();
    bus.once('agent.loop.start', handler);
    bus.off('agent.loop.start', handler);
    bus.emit('agent.loop.start', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires exactly once for a wildcard pattern', () => {
    const handler = vi.fn();
    bus.once('tool.*', handler);
    bus.emit('tool.call.start', {});
    bus.emit('tool.call.end', {});

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].type).toBe('tool.call.start');
  });

  it('wildcard once() can be removed with off() before it fires', () => {
    const handler = vi.fn();
    bus.once('llm.*', handler);
    bus.off('llm.*', handler);
    bus.emit('llm.call.end', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('a permanent on() and a once() on the same event behave independently', () => {
    const permanent = vi.fn();
    const oneTime = vi.fn();
    bus.on('tokens.recorded', permanent);
    bus.once('tokens.recorded', oneTime);
    bus.emit('tokens.recorded', {});
    bus.emit('tokens.recorded', {});

    expect(permanent).toHaveBeenCalledTimes(2);
    expect(oneTime).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeAllListeners()
// ─────────────────────────────────────────────────────────────────────────────

describe('removeAllListeners()', () => {
  it('removeAllListeners() with no args silences all exact handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('agent.loop.start', h1);
    bus.on('tool.call.end', h2);
    bus.removeAllListeners();
    bus.emit('agent.loop.start', {});
    bus.emit('tool.call.end', {});

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('removeAllListeners() with no args silences all wildcard handlers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('tool.*', h1);
    bus.on('llm.*', h2);
    bus.removeAllListeners();
    bus.emit('tool.call.end', {});
    bus.emit('llm.call.end', {});

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('removeAllListeners(event) clears only that exact event', () => {
    const tool = vi.fn();
    const llm = vi.fn();
    bus.on('tool.call.end', tool);
    bus.on('llm.call.end', llm);
    bus.removeAllListeners('tool.call.end');
    bus.emit('tool.call.end', {});
    bus.emit('llm.call.end', {});

    expect(tool).not.toHaveBeenCalled();
    expect(llm).toHaveBeenCalledOnce();
  });

  it('removeAllListeners(pattern) clears only that wildcard pattern', () => {
    const toolWild = vi.fn();
    const llmWild = vi.fn();
    bus.on('tool.*', toolWild);
    bus.on('llm.*', llmWild);
    bus.removeAllListeners('tool.*');
    bus.emit('tool.call.end', {});
    bus.emit('llm.call.end', {});

    expect(toolWild).not.toHaveBeenCalled();
    expect(llmWild).toHaveBeenCalledOnce();
  });

  it('bus can be reused after removeAllListeners()', () => {
    const handler = vi.fn();
    bus.on('agent.loop.end', vi.fn());
    bus.removeAllListeners();
    bus.on('agent.loop.end', handler);
    bus.emit('agent.loop.end', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('removeAllListeners() returns this for chaining', () => {
    expect(bus.removeAllListeners()).toBe(bus);
  });
});
