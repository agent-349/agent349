import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../../src/events/EventBus.js';
import { EventCollector } from '../../../src/audit/EventCollector.js';
import type { AuditRecord } from '../../../src/types/index.js';

describe('EventCollector', () => {
  let bus: EventBus;
  let logs: Partial<AuditRecord>[];
  let collector: EventCollector;

  beforeEach(() => {
    bus = new EventBus();
    logs = [];
    collector = new EventCollector(bus, (p) => logs.push(p));
  });

  // ── start / stop ───────────────────────────────────────────────────────────

  describe('start() + stop()', () => {
    it('does not capture events before start()', () => {
      bus.emit('agent.loop.start', {});
      expect(logs).toHaveLength(0);
    });

    it('captures events after start()', () => {
      collector.start();
      bus.emit('agent.loop.end', { iterations: 3 });
      expect(logs).toHaveLength(1);
    });

    it('stops capturing after stop()', () => {
      collector.start();
      collector.stop();
      bus.emit('agent.loop.end', { iterations: 1 });
      expect(logs).toHaveLength(0);
    });

    it('is idempotent — double start resets listeners', () => {
      collector.start();
      collector.start(); // should reset without double-registering
      bus.emit('tool.call.end', { toolName: 'x', success: true });
      expect(logs).toHaveLength(1);
    });

    it('listenerCount is > 0 after start', () => {
      collector.start();
      expect(collector.listenerCount).toBeGreaterThan(0);
    });

    it('listenerCount is 0 after stop', () => {
      collector.start();
      collector.stop();
      expect(collector.listenerCount).toBe(0);
    });
  });

  // ── event mappings ─────────────────────────────────────────────────────────

  describe('event mappings', () => {
    beforeEach(() => collector.start());

    it('maps agent.loop.start → category:agent, action:loop_start, severity:info', () => {
      bus.emit('agent.loop.start', {});
      expect(logs[0]).toMatchObject({ category: 'agent', action: 'loop_start', severity: 'info' });
    });

    it('maps agent.loop.end → includes iterations in summary', () => {
      bus.emit('agent.loop.end', { iterations: 5 });
      expect(logs[0]?.detail?.summary).toContain('5');
      expect(logs[0]?.category).toBe('agent');
      expect(logs[0]?.action).toBe('loop_end');
    });

    it('maps llm.call.start → category:llm, action:call_start', () => {
      bus.emit('llm.call.start', {});
      expect(logs[0]).toMatchObject({ category: 'llm', action: 'call_start' });
    });

    it('maps llm.call.end → includes metrics from usage', () => {
      bus.emit('llm.call.end', {
        usage: { inputTokens: 100, outputTokens: 50, cost: 0.01 },
        latencyMs: 300,
        performance: {
          streamOpenMs: 40,
          timeToFirstChunkMs: 60,
          timeToFirstTokenMs: 120,
          generationMs: 180,
          visibleOutputTokens: 35,
          visibleTokensPerSecond: 194.4,
          reasoningTokens: 15,
          cachedInputTokens: 20,
        },
      });
      expect(logs[0]?.metrics?.tokensInput).toBe(100);
      expect(logs[0]?.metrics?.tokensOutput).toBe(50);
      expect(logs[0]?.metrics?.durationMs).toBe(300);
      expect(logs[0]?.metrics).toMatchObject({
        streamOpenMs: 40,
        timeToFirstChunkMs: 60,
        timeToFirstTokenMs: 120,
        generationMs: 180,
        visibleOutputTokens: 35,
        visibleTokensPerSecond: 194.4,
        reasoningTokens: 15,
        cachedInputTokens: 20,
      });
    });

    it('maps llm.call.error → outcome:error, severity:warning', () => {
      bus.emit('llm.call.error', { error: 'timeout' });
      expect(logs[0]).toMatchObject({
        category: 'llm',
        action: 'call_error',
        outcome: 'error',
        severity: 'warning',
      });
    });

    it('maps tool.call.start → resource with toolName', () => {
      bus.emit('tool.call.start', { toolName: 'finance.getBalance', input: {} });
      expect(logs[0]?.resource?.id).toBe('finance.getBalance');
      expect(logs[0]?.category).toBe('tool');
    });

    it('maps tool.call.end success → outcome:success', () => {
      bus.emit('tool.call.end', { toolName: 'finance.getBalance', success: true, durationMs: 120 });
      expect(logs[0]?.outcome).toBe('success');
      expect(logs[0]?.metrics?.durationMs).toBe(120);
    });

    it('maps tool.call.end failure → outcome:failure, severity:warning', () => {
      bus.emit('tool.call.end', { toolName: 'finance.getBalance', success: false });
      expect(logs[0]?.outcome).toBe('failure');
      expect(logs[0]?.severity).toBe('warning');
    });

    it('maps tool.call.error → category:tool, action:call_error', () => {
      bus.emit('tool.call.error', { toolName: 'myTool', error: 'timeout' });
      expect(logs[0]).toMatchObject({ category: 'tool', action: 'call_error', outcome: 'error' });
    });

    it('maps rag.pipeline.complete → category:rag, action:search_complete', () => {
      bus.emit('rag.pipeline.complete', { totalLatencyMs: 42, metrics: { searchLatencyMs: 10 } });
      expect(logs[0]).toMatchObject({ category: 'rag', action: 'search_complete' });
      expect(logs[0]?.metrics?.durationMs).toBe(42);
    });

    it('maps individual RAG stage durations', () => {
      bus.emit('rag.embed.end', { latencyMs: 25, dimensions: 1536 });
      expect(logs[0]).toMatchObject({ category: 'rag', action: 'embedding' });
      expect(logs[0]?.metrics?.durationMs).toBe(25);
    });

    it('maps host chat stages using the supplied stage name', () => {
      bus.emit('rag.chat.stage', { stage: 'source_mapping', durationMs: 8 });
      expect(logs[0]).toMatchObject({ category: 'rag', action: 'source_mapping' });
      expect(logs[0]?.metrics?.durationMs).toBe(8);
    });

    it('maps security.approval.denied → security/approval_denied, blocked', () => {
      bus.emit('security.approval.denied', {
        actionId: 'a-1',
        toolName: 'payments.transfer',
        decision: 'approve',
        reason: 'approver holds none of the roles [treasurer]',
      });
      expect(logs[0]).toMatchObject({
        category: 'security',
        action: 'approval_denied',
        outcome: 'blocked',
        severity: 'warning',
        resource: { type: 'approval', id: 'a-1', name: 'payments.transfer' },
      });
    });

    it('maps security.acl.denied → severity:warning, outcome:blocked', () => {
      bus.emit('security.acl.denied', { reason: 'insufficient roles' });
      expect(logs[0]).toMatchObject({
        category: 'security',
        action: 'access_denied',
        outcome: 'blocked',
        severity: 'warning',
      });
    });

    it('maps security.injection.detected → severity:critical, injectionDetected:true', () => {
      bus.emit('security.injection.detected', { riskLevel: 'high', action: 'block', patterns: [] });
      expect(logs[0]?.security?.injectionDetected).toBe(true);
      expect(logs[0]?.severity).toBe('critical');
      expect(logs[0]?.outcome).toBe('blocked');
    });

    it('maps security.ratelimit.hit → category:security, outcome:blocked', () => {
      bus.emit('security.ratelimit.hit', { key: 'tenant:t1' });
      expect(logs[0]).toMatchObject({
        category: 'security',
        action: 'rate_limit_hit',
        outcome: 'blocked',
      });
    });

    it('maps tokens.recorded → category:system, action:token_usage', () => {
      bus.emit('tokens.recorded', { tokens: 1500, tenantId: 't1', userId: 'u1' });
      expect(logs[0]).toMatchObject({ category: 'system', action: 'token_usage' });
    });

    it('maps memory.compress → category:memory, action:compression', () => {
      bus.emit('memory.compress', {});
      expect(logs[0]).toMatchObject({ category: 'memory', action: 'compression' });
    });

    it('maps security.field.masked → category:security, fieldsMasked set', () => {
      bus.emit('security.field.masked', { toolName: 'hr.getEmployee', fields: ['salary', 'ssn'] });
      expect(logs[0]).toMatchObject({
        category: 'security',
        action: 'field_masked',
        outcome: 'success',
      });
      expect(logs[0]?.security?.fieldsMasked).toEqual(['salary', 'ssn']);
    });

    it('maps session.created → category:session, resource set', () => {
      bus.emit('session.created', { sessionId: 's1' });
      expect(logs[0]).toMatchObject({
        category: 'session',
        action: 'session_created',
        outcome: 'success',
      });
      expect(logs[0]?.resource).toMatchObject({ type: 'session', id: 's1' });
    });

    it('maps session.closed → category:session, action:session_closed', () => {
      bus.emit('session.closed', { sessionId: 's1' });
      expect(logs[0]).toMatchObject({ category: 'session', action: 'session_closed' });
    });

    it('maps skill.activated → category:skill, resource set', () => {
      bus.emit('skill.activated', { skillId: 'finance' });
      expect(logs[0]).toMatchObject({ category: 'skill', action: 'skill_activated' });
      expect(logs[0]?.resource).toMatchObject({ type: 'skill', id: 'finance' });
    });
  });

  // ── _context extraction ────────────────────────────────────────────────────

  describe('_context extraction', () => {
    beforeEach(() => collector.start());

    it('extracts tenantId from _context', () => {
      bus.emit('agent.loop.start', { _context: { tenantId: 'acme' } });
      expect(logs[0]?.tenantId).toBe('acme');
    });

    it('extracts userId and requestId from _context', () => {
      bus.emit('tool.call.end', {
        toolName: 'x',
        success: true,
        _context: { userId: 'u42', requestId: 'req-99' },
      });
      expect(logs[0]?.userId).toBe('u42');
      expect(logs[0]?.requestId).toBe('req-99');
    });

    it('does not fail when _context is absent', () => {
      bus.emit('agent.loop.start', {});
      expect(logs[0]?.tenantId).toBeUndefined();
    });
  });
});
