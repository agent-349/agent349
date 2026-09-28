import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuditWriteBuffer } from '../../../src/audit/AuditWriteBuffer.js';
import type { AuditRecord } from '../../../src/types/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeRecord(id: string): AuditRecord {
  return {
    id,
    timestamp: new Date(),
    requestId: 'req-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-a',
    userId: 'user-1',
    agentId: 'agent-1',
    category: 'tool',
    action: 'call_end',
    outcome: 'success',
    severity: 'info',
  };
}

describe('AuditWriteBuffer', () => {
  // ── add() + flush() ────────────────────────────────────────────────────────

  describe('flush()', () => {
    it('flushes all buffered records and clears the buffer', async () => {
      const flushed: AuditRecord[][] = [];
      const buf = new AuditWriteBuffer({
        maxSize: 100,
        flushIntervalMs: 60_000,
        onFlush: async (records) => {
          flushed.push(records);
        },
        onError: vi.fn(),
      });

      buf.add(makeRecord('r1'));
      buf.add(makeRecord('r2'));
      const count = await buf.flush();

      expect(count).toBe(2);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toHaveLength(2);
      expect(buf.size).toBe(0);

      await buf.shutdown();
    });

    it('returns 0 and calls onFlush 0 times for an empty buffer', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const buf = new AuditWriteBuffer({
        maxSize: 100,
        flushIntervalMs: 60_000,
        onFlush,
        onError: vi.fn(),
      });
      const count = await buf.flush();
      expect(count).toBe(0);
      expect(onFlush).not.toHaveBeenCalled();
      await buf.shutdown();
    });
  });

  // ── maxSize triggers auto-flush ─────────────────────────────────────────────

  describe('add() — auto-flush on maxSize', () => {
    it('triggers an immediate flush when maxSize is reached', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const buf = new AuditWriteBuffer({
        maxSize: 2,
        flushIntervalMs: 60_000,
        onFlush,
        onError: vi.fn(),
      });

      buf.add(makeRecord('r1'));
      buf.add(makeRecord('r2')); // triggers flush

      // Give the async flush a chance to run
      await new Promise((r) => setTimeout(r, 10));

      expect(onFlush).toHaveBeenCalled();
      await buf.shutdown();
    });
  });

  // ── Error handling — reinsertion ────────────────────────────────────────────

  describe('error handling', () => {
    it('reinserts records at front of buffer when onFlush throws', async () => {
      const onError = vi.fn();
      const onFlush = vi.fn().mockRejectedValue(new Error('store unavailable'));
      const buf = new AuditWriteBuffer({ maxSize: 100, flushIntervalMs: 60_000, onFlush, onError });

      buf.add(makeRecord('r1'));
      buf.add(makeRecord('r2'));
      const count = await buf.flush();

      expect(count).toBe(0);
      expect(onError).toHaveBeenCalledOnce();
      // Records reinserted — size should be back to 2
      expect(buf.size).toBe(2);

      // Prevent the timer from flushing in teardown (no-op shutdown)
      onFlush.mockResolvedValue(undefined);
      await buf.shutdown();
    });

    it('calls onError with an Error instance and the failed batch', async () => {
      const onError = vi.fn();
      const err = new Error('db down');
      const onFlush = vi.fn().mockRejectedValue(err);
      const buf = new AuditWriteBuffer({ maxSize: 100, flushIntervalMs: 60_000, onFlush, onError });

      buf.add(makeRecord('r1'));
      await buf.flush();

      expect(onError).toHaveBeenCalledWith(err, [expect.objectContaining({ id: 'r1' })]);

      onFlush.mockResolvedValue(undefined);
      await buf.shutdown();
    });
  });

  // ── Periodic flush ──────────────────────────────────────────────────────────

  describe('periodic flush (real timer)', () => {
    it('flushes automatically after flushIntervalMs elapses', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const buf = new AuditWriteBuffer({
        maxSize: 100,
        flushIntervalMs: 50,
        onFlush,
        onError: vi.fn(),
      });

      buf.add(makeRecord('r1'));
      expect(onFlush).not.toHaveBeenCalled();

      // Wait longer than the flush interval
      await new Promise((r) => setTimeout(r, 150));

      expect(onFlush).toHaveBeenCalled();
      await buf.shutdown();
    });
  });

  // ── shutdown() ──────────────────────────────────────────────────────────────

  describe('shutdown()', () => {
    it('flushes remaining records and stops the timer', async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      const buf = new AuditWriteBuffer({
        maxSize: 100,
        flushIntervalMs: 60_000,
        onFlush,
        onError: vi.fn(),
      });

      buf.add(makeRecord('r1'));
      await buf.shutdown();

      expect(onFlush).toHaveBeenCalledWith([expect.objectContaining({ id: 'r1' })]);
      expect(buf.size).toBe(0);
    });
  });
});
