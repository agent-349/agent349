import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuditLogger } from '../../../src/audit/AuditLogger.js';
import { InMemoryAuditStore } from '../../../src/audit/store/InMemoryAuditStore.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { ExecutionContext } from '../../../src/types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    tenantId: 'tenant-a',
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'sess-001',
    requestId: 'req-001',
    roles: ['user'],
    ...overrides,
  };
}

function makeDeps() {
  const store = new InMemoryAuditStore();
  const bus = new EventBus();
  return { store, bus };
}

describe('AuditLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── log() ─────────────────────────────────────────────────────────────────

  describe('log()', () => {
    it('returns a UUID string', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      await logger.stopAutoCapture();
    });

    it('generates unique ids per call', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 10, flushIntervalMs: 60_000 },
      });
      const id1 = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      const id2 = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      expect(id1).not.toBe(id2);
      await logger.stopAutoCapture();
    });

    it('flushes to store and record is retrievable by id', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      // maxSize=1 triggers immediate flush
      await new Promise((r) => setTimeout(r, 10));
      const found = await store.getById(id);
      expect(found).not.toBeNull();
      expect(found?.action).toBe('call_end');
      await logger.stopAutoCapture();
    });

    it('attaches _integrityHash to every record', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?._integrityHash).toBeDefined();
      expect(record!._integrityHash!.length).toBe(64);
      await logger.stopAutoCapture();
    });

    it('defaults missing fields to empty string / sensible defaults', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({});
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.tenantId).toBe('');
      expect(record?.category).toBe('system');
      await logger.stopAutoCapture();
    });
  });

  // ── logSecurity() ─────────────────────────────────────────────────────────

  describe('logSecurity()', () => {
    it('creates a record with category:security and outcome:blocked', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const ctx = makeContext();
      const id = await logger.logSecurity('access_denied', ctx, { summary: 'denied' });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.category).toBe('security');
      expect(record?.outcome).toBe('blocked');
      expect(record?.tenantId).toBe(ctx.tenantId);
      await logger.stopAutoCapture();
    });
  });

  // ── flush() ───────────────────────────────────────────────────────────────

  describe('flush()', () => {
    it('returns the number of records flushed', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      await logger.log({ category: 'tool', action: 'x', outcome: 'success', severity: 'info' });
      await logger.log({ category: 'llm', action: 'y', outcome: 'success', severity: 'info' });
      const count = await logger.flush();
      expect(count).toBe(2);
      await logger.stopAutoCapture();
    });
  });

  // ── getById / getByRequestId ───────────────────────────────────────────────

  describe('getById()', () => {
    it('retrieves a record by id after flush', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      await logger.flush();
      const record = await logger.getById(id);
      expect(record?.id).toBe(id);
      await logger.stopAutoCapture();
    });

    it('returns null for an unknown id', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      expect(await logger.getById('nonexistent')).toBeNull();
      await logger.stopAutoCapture();
    });
  });

  describe('getByRequestId()', () => {
    it('returns all records for a request', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      await logger.log({
        requestId: 'req-X',
        category: 'tool',
        action: 'a',
        outcome: 'success',
        severity: 'info',
      });
      await logger.log({
        requestId: 'req-X',
        category: 'llm',
        action: 'b',
        outcome: 'success',
        severity: 'info',
      });
      await logger.log({
        requestId: 'req-Y',
        category: 'tool',
        action: 'c',
        outcome: 'success',
        severity: 'info',
      });
      await logger.flush();
      const records = await logger.getByRequestId('req-X');
      expect(records).toHaveLength(2);
      await logger.stopAutoCapture();
    });
  });

  // ── getSessionTimeline ────────────────────────────────────────────────────

  describe('getSessionTimeline()', () => {
    it('returns records for the session in chronological order', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      // Write directly to store with known timestamps
      await store.writeBatch([
        {
          id: 'r1',
          timestamp: new Date('2026-01-01T10:00:00Z'),
          requestId: 'req-1',
          sessionId: 'sess-X',
          tenantId: 't',
          userId: 'u',
          agentId: 'a',
          category: 'agent',
          action: 'loop_start',
          outcome: 'success',
          severity: 'info',
        },
        {
          id: 'r2',
          timestamp: new Date('2026-01-01T10:01:00Z'),
          requestId: 'req-1',
          sessionId: 'sess-X',
          tenantId: 't',
          userId: 'u',
          agentId: 'a',
          category: 'tool',
          action: 'call_end',
          outcome: 'success',
          severity: 'info',
        },
      ]);
      const timeline = await logger.getSessionTimeline('sess-X');
      expect(timeline).toHaveLength(2);
      expect(timeline[0]!.action).toBe('loop_start');
      expect(timeline[1]!.action).toBe('call_end');
      await logger.stopAutoCapture();
    });
  });

  // ── auto-capture ──────────────────────────────────────────────────────────

  describe('startAutoCapture() — auto-capture of EventBus events', () => {
    it('automatically logs tool.call.end events', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      logger.startAutoCapture();

      bus.emit('tool.call.end', {
        toolName: 'finance.getBalance',
        success: true,
        durationMs: 120,
        _context: { tenantId: 't1', userId: 'u1', agentId: 'a1', sessionId: 's1', requestId: 'r1' },
      });

      await logger.flush();
      const result = await logger.query({
        tenantId: 't1',
        category: 'tool',
        dateRange: { from: new Date(0), to: new Date() },
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.action).toBe('call_end');
      expect(result.records[0]!.outcome).toBe('success');

      await logger.stopAutoCapture();
    });

    it('automatically logs security.injection.detected events', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      logger.startAutoCapture();

      bus.emit('security.injection.detected', {
        riskLevel: 'high',
        action: 'block',
        patterns: [],
        _context: { tenantId: 't1' },
      });

      await logger.flush();
      const result = await logger.query({
        category: 'security',
        dateRange: { from: new Date(0), to: new Date() },
      });
      expect(result.records[0]?.security?.injectionDetected).toBe(true);
      expect(result.records[0]?.severity).toBe('critical');

      await logger.stopAutoCapture();
    });

    it('does not capture events after stopAutoCapture()', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      logger.startAutoCapture();
      await logger.stopAutoCapture();

      bus.emit('agent.loop.end', { iterations: 2 });

      const result = await logger.query({
        category: 'agent',
        dateRange: { from: new Date(0), to: new Date() },
      });
      expect(result.records).toHaveLength(0);
    });
  });

  // ── verbosity ─────────────────────────────────────────────────────────────

  describe('verbosity', () => {
    it('minimal: strips input/output from detail', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        verbosity: 'minimal',
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { summary: 'done', input: { x: 1 }, output: { y: 2 } },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.detail?.summary).toBe('done');
      expect(record?.detail?.input).toBeUndefined();
      expect(record?.detail?.output).toBeUndefined();
      await logger.stopAutoCapture();
    });

    it('standard: includes input/output but not verbose fields', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        verbosity: 'standard',
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { summary: 'done', input: { x: 1 }, output: { y: 2 }, messages: [] },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.detail?.input).toEqual({ x: 1 });
      expect(record?.detail?.messages).toBeUndefined();
      await logger.stopAutoCapture();
    });

    it('verbose: includes all detail fields', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        verbosity: 'verbose',
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { summary: 'done', input: { x: 1 }, messages: [{ role: 'user', content: 'hi' }] },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.detail?.messages).toHaveLength(1);
      await logger.stopAutoCapture();
    });

    it('verbosityOverrides: security category uses override level', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        verbosity: 'minimal',
        verbosityOverrides: { security: 'verbose' },
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'security',
        action: 'injection_detected',
        outcome: 'blocked',
        severity: 'critical',
        detail: { summary: 'high risk', input: { patterns: [] }, messages: [] },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      // security override is verbose → messages should be present
      expect(record?.detail?.messages).toBeDefined();
      await logger.stopAutoCapture();
    });
  });

  // ── sensitive data redaction ───────────────────────────────────────────────

  describe('sensitive data redaction', () => {
    it('redacts email addresses in detail.summary', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        sensitiveData: { enabled: true },
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { summary: 'User alice@example.com triggered action' },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.detail?.summary).not.toContain('alice@example.com');
      expect(record?.detail?.summary).toContain('[EMAIL]');
      await logger.stopAutoCapture();
    });

    it('redacts globalRedactFields from detail.input', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        sensitiveData: { enabled: true, globalRedactFields: ['password'] },
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { input: { username: 'alice', password: 'secret' } },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?.detail?.input?.password).toBe('[REDACTED]');
      expect(record?.detail?.input?.username).toBe('alice');
      await logger.stopAutoCapture();
    });

    it('skips redaction when sensitiveData.enabled is false', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        sensitiveData: { enabled: false },
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
        detail: { summary: 'Contact: bob@example.com' },
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      // No redaction → original email preserved
      expect(record?.detail?.summary).toContain('bob@example.com');
      await logger.stopAutoCapture();
    });
  });

  // ── integrity hash ─────────────────────────────────────────────────────────

  describe('integrity hash', () => {
    it('every persisted record has a valid _integrityHash', async () => {
      const { store, bus } = makeDeps();
      const { IntegrityHash } = await import('../../../src/audit/IntegrityHash.js');
      const ih = new IntegrityHash();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 1, flushIntervalMs: 60_000 },
      });
      const id = await logger.log({
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      await new Promise((r) => setTimeout(r, 10));
      const record = await store.getById(id);
      expect(record?._integrityHash).toBeDefined();
      expect(ih.verify(record!)).toBe(true);
      await logger.stopAutoCapture();
    });
  });

  // ── query() ───────────────────────────────────────────────────────────────

  describe('query()', () => {
    it('returns records matching the filter', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      await logger.log({
        tenantId: 'a',
        category: 'tool',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      await logger.log({
        tenantId: 'b',
        category: 'llm',
        action: 'call_end',
        outcome: 'success',
        severity: 'info',
      });
      await logger.flush();

      const result = await logger.query({
        tenantId: 'a',
        dateRange: { from: new Date(0), to: new Date() },
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.tenantId).toBe('a');
      await logger.stopAutoCapture();
    });
  });

  // ── getStats() ─────────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns totalRecords and byCategory', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });
      await store.writeBatch([
        {
          id: 'r1',
          timestamp: new Date(),
          requestId: 'req',
          sessionId: 's',
          tenantId: 't1',
          userId: 'u',
          agentId: 'a',
          category: 'tool',
          action: 'call_end',
          outcome: 'success',
          severity: 'info',
        },
        {
          id: 'r2',
          timestamp: new Date(),
          requestId: 'req',
          sessionId: 's',
          tenantId: 't1',
          userId: 'u',
          agentId: 'a',
          category: 'security',
          action: 'access_denied',
          outcome: 'blocked',
          severity: 'warning',
        },
      ]);

      const stats = await logger.getStats('t1', { from: new Date(0), to: new Date() });
      expect(stats.totalRecords).toBe(2);
      expect(stats.byCategory['tool']).toBe(1);
      expect(stats.byCategory['security']).toBe(1);
      expect(stats.securityIncidents).toBe(1);
      await logger.stopAutoCapture();
    });
  });

  // ── applyRetention() ──────────────────────────────────────────────────────

  describe('applyRetention()', () => {
    it('deletes records older than the default 90 days', async () => {
      const { store, bus } = makeDeps();
      const logger = new AuditLogger(store, bus, {
        buffer: { maxSize: 100, flushIntervalMs: 60_000 },
      });

      const old = new Date();
      old.setDate(old.getDate() - 100); // 100 days ago
      await store.writeBatch([
        {
          id: 'old-1',
          timestamp: old,
          requestId: 'r',
          sessionId: 's',
          tenantId: 't',
          userId: 'u',
          agentId: 'a',
          category: 'tool',
          action: 'x',
          outcome: 'success',
          severity: 'info',
        },
        {
          id: 'new-1',
          timestamp: new Date(),
          requestId: 'r',
          sessionId: 's',
          tenantId: 't',
          userId: 'u',
          agentId: 'a',
          category: 'tool',
          action: 'x',
          outcome: 'success',
          severity: 'info',
        },
      ]);

      const result = await logger.applyRetention();
      expect(result.recordsDeleted).toBe(1);
      expect(store.recordCount).toBe(1);
      await logger.stopAutoCapture();
    });
  });
});
