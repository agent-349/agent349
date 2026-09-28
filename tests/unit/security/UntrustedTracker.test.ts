import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UntrustedTracker } from '../../../src/security/UntrustedTracker.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { ExecutionContext, ToolResult } from '../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function ctx(requestId: string): ExecutionContext {
  return {
    tenantId: 'acme',
    userId: 'u1',
    roles: ['viewer'],
    sessionId: 's1',
    agentId: 'agent-1',
    requestId,
  };
}

const TAINTED: ToolResult = { success: true, data: 'page text', untrusted: true };
const CLEAN: ToolResult = { success: true, data: 'rows' };

let bus: EventBus;
let inflow: ReturnType<typeof vi.fn>;
let mutating: ReturnType<typeof vi.fn>;
let tracker: UntrustedTracker;

beforeEach(() => {
  bus = new EventBus();
  inflow = vi.fn();
  mutating = vi.fn();
  bus.on('security.untrusted.inflow', inflow);
  bus.on('security.untrusted.mutating', mutating);
  tracker = new UntrustedTracker(bus);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inflow
// ─────────────────────────────────────────────────────────────────────────────

describe('UntrustedTracker inflow', () => {
  it('ignores results that are not flagged untrusted', () => {
    tracker.record(ctx('r1'), 'sql.query', CLEAN);

    expect(inflow).not.toHaveBeenCalled();
    expect(tracker.isTainted(ctx('r1'))).toBe(false);
  });

  it('marks the turn and emits when untrusted content arrives', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);

    expect(tracker.isTainted(ctx('r1'))).toBe(true);
    expect(inflow).toHaveBeenCalledTimes(1);
  });

  it('identifies the turn and the tool in the event', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);

    expect(inflow.mock.calls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ toolName: 'web.read', requestId: 'r1', userId: 'u1' }),
    });
  });

  // The fifth page read adds no information; a per-call event would drown the
  // signal it exists to carry.
  it('emits once per turn however many untrusted results arrive', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.record(ctx('r1'), 'web.read', TAINTED);

    expect(inflow).toHaveBeenCalledTimes(1);
  });

  it('keeps turns independent of each other', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);

    expect(tracker.isTainted(ctx('r2'))).toBe(false);
    expect(inflow).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Side effects
// ─────────────────────────────────────────────────────────────────────────────

describe('UntrustedTracker side effects', () => {
  it('stays quiet when the turn took in nothing untrusted', () => {
    tracker.noteSideEffect(ctx('r1'), 'mail.send');
    expect(mutating).not.toHaveBeenCalled();
  });

  // The combination is the risk: an inlet and an outlet in the same turn.
  // Neither tool can see it from the inside, which is why this exists.
  it('flags an outlet running in a turn that already took in untrusted content', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.noteSideEffect(ctx('r1'), 'mail.send');

    expect(mutating).toHaveBeenCalledTimes(1);
    expect(mutating.mock.calls[0]?.[0]).toMatchObject({
      data: expect.objectContaining({ toolName: 'mail.send', requestId: 'r1' }),
    });
  });

  it('does not flag an outlet in a different, clean turn', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.noteSideEffect(ctx('r2'), 'mail.send');

    expect(mutating).not.toHaveBeenCalled();
  });

  it('flags every outlet in a tainted turn, not just the first', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.noteSideEffect(ctx('r1'), 'mail.send');
    tracker.noteSideEffect(ctx('r1'), 'crm.createNote');

    expect(mutating).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

describe('UntrustedTracker bookkeeping', () => {
  it('forgets a turn on clear', () => {
    tracker.record(ctx('r1'), 'web.read', TAINTED);
    tracker.clear(ctx('r1'));

    expect(tracker.isTainted(ctx('r1'))).toBe(false);
  });

  it('drops the oldest turns past the cap so memory stays bounded', () => {
    const bounded = new UntrustedTracker(bus, { maxTracked: 2 });
    bounded.record(ctx('r1'), 'web.read', TAINTED);
    bounded.record(ctx('r2'), 'web.read', TAINTED);
    bounded.record(ctx('r3'), 'web.read', TAINTED);

    expect(bounded.isTainted(ctx('r1'))).toBe(false);
    expect(bounded.isTainted(ctx('r2'))).toBe(true);
    expect(bounded.isTainted(ctx('r3'))).toBe(true);
  });
});
