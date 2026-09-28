import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityMiddlewareChain } from '../../../../src/security/middleware/SecurityMiddlewareChain.js';
import { FieldMasker } from '../../../../src/security/FieldMasker.js';
import { FieldMaskMiddleware } from '../../../../src/security/middleware/FieldMaskMiddleware.js';
import { EventBus } from '../../../../src/events/EventBus.js';
import type { SecurityMiddleware, MiddlewareResult } from '../../../../src/security/types.js';
import type { ExecutionContext } from '../../../../src/types/index.js';
import type { AgentEvent } from '../../../../src/types/index.js';

function makeCtx(): ExecutionContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    agentId: 'a1',
    sessionId: 's1',
    requestId: 'r1',
    roles: ['user'],
  };
}

function fakeMiddleware(result: MiddlewareResult): SecurityMiddleware {
  return {
    name: 'fake',
    phase: 'pre',
    priority: 10,
    appliesTo: 'all',
    execute: async () => result,
  };
}

let bus: EventBus;
let captured: AgentEvent[];

beforeEach(() => {
  bus = new EventBus();
  captured = [];
  bus.on('*', (e) => captured.push(e));
});

describe('SecurityMiddlewareChain — event emission', () => {
  it('emits middleware-reported events enriched with _context', async () => {
    const chain = new SecurityMiddlewareChain(bus);
    chain.use(
      fakeMiddleware({
        action: 'block',
        reason: 'nope',
        events: [{ type: 'security.acl.denied', data: { toolName: 'x', reason: 'nope' } }],
      }),
    );

    await chain.executePre(makeCtx(), { type: 'tool_call', toolName: 'x' });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('security.acl.denied');
    expect(captured[0]!.data['toolName']).toBe('x');
    expect(captured[0]!.data['_context']).toMatchObject({ tenantId: 't1', requestId: 'r1' });
  });

  it('emits block-path events before stopping the chain', async () => {
    const chain = new SecurityMiddlewareChain(bus);
    chain.use(
      fakeMiddleware({
        action: 'block',
        events: [{ type: 'security.ratelimit.hit', data: { key: 'tenant:t1' } }],
      }),
    );
    const result = await chain.executePre(makeCtx(), { type: 'agent_start', message: 'hi' });
    expect(result.action).toBe('block');
    expect(captured.map((e) => e.type)).toContain('security.ratelimit.hit');
  });

  it('does nothing (and does not throw) when no bus is configured', async () => {
    const chain = new SecurityMiddlewareChain(); // no bus
    chain.use(
      fakeMiddleware({
        action: 'continue',
        events: [{ type: 'security.field.masked', data: { fields: ['x'] } }],
      }),
    );
    await expect(
      chain.executePre(makeCtx(), { type: 'tool_call', toolName: 'x' }),
    ).resolves.toMatchObject({ action: 'continue' });
    expect(captured).toHaveLength(0);
  });

  it('FieldMaskMiddleware emits security.field.masked with the masked field names', async () => {
    const masker = new FieldMasker([
      { toolName: 'hr.get', field: 'salary', maskType: 'redact', visibleToRoles: ['admin'] },
    ]);
    const chain = new SecurityMiddlewareChain(bus);
    chain.use(new FieldMaskMiddleware(masker));

    await chain.executePost(makeCtx(), {
      type: 'tool_result',
      toolName: 'hr.get',
      output: { name: 'Bob', salary: 9000 },
    });

    const ev = captured.find((e) => e.type === 'security.field.masked');
    expect(ev).toBeDefined();
    expect(ev!.data['fields']).toEqual(['salary']);
    expect(ev!.data['_context']).toMatchObject({ tenantId: 't1' });
  });
});
