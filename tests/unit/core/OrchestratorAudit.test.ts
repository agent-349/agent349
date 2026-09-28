import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { ConfigError } from '../../../src/errors/index.js';
import { AuditLogger } from '../../../src/audit/AuditLogger.js';
import { InMemoryAuditStore } from '../../../src/audit/store/InMemoryAuditStore.js';
import { SIEMForwarder } from '../../../src/audit/siem/SIEMForwarder.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { AuditRecord } from '../../../src/types/index.js';
import type { ForwardResult } from '../../../src/audit/types.js';

const RANGE = { from: new Date(0), to: new Date(Date.now() + 60_000) };

class CapturingForwarder extends SIEMForwarder {
  readonly name = 'capturing';
  readonly batches: AuditRecord[][] = [];
  closed = false;
  async forward(records: AuditRecord[]): Promise<ForwardResult> {
    this.batches.push(records);
    return { sent: records.length, failed: 0 };
  }
  override async close(): Promise<void> {
    this.closed = true;
  }
}

describe('Orchestrator audit wiring', () => {
  it('does not build an audit logger when audit.enabled is false (default)', async () => {
    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    expect(orch.audit).toBeUndefined();
    await orch.shutdown();
  });

  it('builds an audit logger with the in-memory store when enabled', async () => {
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config);
    expect(orch.audit).toBeInstanceOf(AuditLogger);
    await orch.shutdown();
  });

  it('captures EventBus events as audit records', async () => {
    const config = ConfigLoader.from({
      audit: { enabled: true, buffer: { maxSize: 1, flushIntervalMs: 50 } },
    }).get();
    const orch = await Orchestrator.fromConfig(config);

    orch.events.emit('tool.call.end', {
      toolName: 'echo',
      success: true,
      durationMs: 12,
      _context: { tenantId: 'acme', userId: 'u1', agentId: 'a1', sessionId: 's1', requestId: 'r1' },
    });

    await orch.audit!.flush();
    const result = await orch.audit!.query({ tenantId: 'acme', dateRange: RANGE });
    expect(result.total).toBe(1);
    expect(result.records[0]!.category).toBe('tool');
    expect(result.records[0]!.action).toBe('call_end');
    await orch.shutdown();
  });

  it('uses an injected audit store via overrides.auditStore', async () => {
    const store = new InMemoryAuditStore();
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config, { auditStore: store });

    orch.events.emit('agent.loop.start', {
      _context: { tenantId: 'acme', userId: 'u1', agentId: 'a1' },
    });
    await orch.audit!.flush();
    expect(store.recordCount).toBe(1);
    await orch.shutdown();
  });

  it('does not close an injected audit store on shutdown', async () => {
    const store = new InMemoryAuditStore();
    const closeSpy = vi.spyOn(store, 'close');
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config, { auditStore: store });
    await orch.shutdown();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('uses a fully injected auditLogger via overrides.auditLogger', async () => {
    const store = new InMemoryAuditStore();
    const logger = new AuditLogger(store, new EventBus(), {});
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config, { auditLogger: logger });
    expect(orch.audit).toBe(logger);
    await orch.shutdown();
  });

  it('flushes buffered records on shutdown', async () => {
    const store = new InMemoryAuditStore();
    const config = ConfigLoader.from({
      audit: { enabled: true, buffer: { maxSize: 1000, flushIntervalMs: 100000 } },
    }).get();
    const orch = await Orchestrator.fromConfig(config, { auditStore: store });

    orch.events.emit('tool.call.end', {
      toolName: 'echo',
      success: true,
      _context: { tenantId: 'acme', userId: 'u1', agentId: 'a1' },
    });
    expect(store.recordCount).toBe(0); // still buffered
    await orch.shutdown(); // should flush
    expect(store.recordCount).toBe(1);
  });
});

describe('audit config validation', () => {
  it('rejects a mongo audit store without uri', () => {
    expect(() =>
      ConfigLoader.from({
        audit: { enabled: true, store: { type: 'mongo', database: 'd' } as never },
      }),
    ).toThrow(ConfigError);
  });

  it('rejects an invalid verbosity', () => {
    expect(() =>
      ConfigLoader.from({ audit: { enabled: true, verbosity: 'loud' as never } }),
    ).toThrow(ConfigError);
  });

  it('does not validate the store when audit is disabled', () => {
    expect(() =>
      ConfigLoader.from({
        audit: { enabled: false, store: { type: 'mongo', database: 'd' } as never },
      }),
    ).not.toThrow();
  });

  it('rejects a webhook SIEM without url', () => {
    expect(() =>
      ConfigLoader.from({
        audit: { enabled: true, siem: { type: 'webhook' } as never },
      }),
    ).toThrow(ConfigError);
  });
});

describe('Orchestrator SIEM forwarding', () => {
  it('forwards flushed batches to an injected forwarder', async () => {
    const store = new InMemoryAuditStore();
    const forwarder = new CapturingForwarder();
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config, {
      auditStore: store,
      siemForwarder: forwarder,
    });

    orch.events.emit('tool.call.end', {
      toolName: 'echo',
      success: true,
      _context: { tenantId: 'acme', userId: 'u1', agentId: 'a1' },
    });
    await orch.audit!.flush();

    expect(forwarder.batches).toHaveLength(1);
    expect(forwarder.batches[0]![0]!.action).toBe('call_end');
    await orch.shutdown();
    expect(forwarder.closed).toBe(true);
  });

  it('does not forward when audit.siem is none (default)', async () => {
    const store = new InMemoryAuditStore();
    const config = ConfigLoader.from({ audit: { enabled: true } }).get();
    const orch = await Orchestrator.fromConfig(config, { auditStore: store });
    orch.events.emit('tool.call.end', {
      toolName: 'x',
      success: true,
      _context: { tenantId: 'acme' },
    });
    await orch.audit!.flush();
    // No forwarder configured → nothing to assert beyond no throw; records persisted.
    expect(store.recordCount).toBe(1);
    await orch.shutdown();
  });
});
