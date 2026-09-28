import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../../src/session/SessionManager.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { AgentEvent } from '../../../src/types/index.js';

let bus: EventBus;
let events: AgentEvent[];
let sm: SessionManager;

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.on('*', (e) => events.push(e));
  sm = new SessionManager(new InMemoryAdapter(), bus);
});

describe('SessionManager event emission', () => {
  it('emits session.created with _context on create()', async () => {
    const s = await sm.create('acme', 'u1', 'agent-1');
    const ev = events.find((e) => e.type === 'session.created');
    expect(ev).toBeDefined();
    expect(ev!.data['sessionId']).toBe(s.sessionId);
    expect(ev!.data['_context']).toMatchObject({
      tenantId: 'acme',
      userId: 'u1',
      agentId: 'agent-1',
    });
  });

  it('emits session.closed with _context on close()', async () => {
    const s = await sm.create('acme', 'u1', 'agent-1');
    events.length = 0;
    await sm.close(s.sessionId);
    const ev = events.find((e) => e.type === 'session.closed');
    expect(ev).toBeDefined();
    expect(ev!.data['_context']).toMatchObject({ tenantId: 'acme', sessionId: s.sessionId });
  });

  it('does not emit when closing a non-existent session', async () => {
    await sm.close('missing');
    expect(events).toHaveLength(0);
  });

  it('works without a bus (no emission, no throw)', async () => {
    const silent = new SessionManager(new InMemoryAdapter());
    const s = await silent.create('acme', 'u1', 'agent-1');
    await expect(silent.close(s.sessionId)).resolves.toBeUndefined();
  });
});
