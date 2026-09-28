import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/core/Orchestrator.js';
import { ConfigLoader } from '../../../src/config/ConfigLoader.js';
import { LoggerAdapter, type LogEntry } from '../../../src/logging/LoggerAdapter.js';

class CapturingLogger extends LoggerAdapter {
  readonly name = 'capturing';
  readonly entries: LogEntry[] = [];
  log(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Orchestrator logging wiring', () => {
  it('stays silent by default (noop adapter, no console output)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const orch = await Orchestrator.fromConfig(ConfigLoader.from().get());
    orch.events.emit('llm.call.error', { _context: { tenantId: 'acme' } });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    await orch.shutdown();
  });

  it('forwards events to an injected logger', async () => {
    const logger = new CapturingLogger();
    const config = ConfigLoader.from({ logging: { level: 'debug' } }).get();
    const orch = await Orchestrator.fromConfig(config, { logger });

    orch.events.emit('tool.call.end', {
      toolName: 'echo',
      success: true,
      _context: { tenantId: 'acme', userId: 'u1' },
    });

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]!.event).toBe('tool.call.end');
    expect(logger.entries[0]!.context).toEqual({ tenantId: 'acme', userId: 'u1' });
    await orch.shutdown();
  });

  it('respects the configured minimum level', async () => {
    const logger = new CapturingLogger();
    const config = ConfigLoader.from({ logging: { level: 'warn' } }).get();
    const orch = await Orchestrator.fromConfig(config, { logger });

    orch.events.emit('tool.call.start', {}); // debug → dropped
    orch.events.emit('security.acl.denied', {}); // warn → kept

    expect(logger.entries.map((e) => e.event)).toEqual(['security.acl.denied']);
    await orch.shutdown();
  });

  it('builds a console adapter when logging.adapter is "console"', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const config = ConfigLoader.from({ logging: { adapter: 'console', level: 'debug' } }).get();
    const orch = await Orchestrator.fromConfig(config);

    orch.events.emit('agent.thinking', { _context: { tenantId: 'acme' } });
    expect(infoSpy).toHaveBeenCalled();
    await orch.shutdown();
  });

  it('stops forwarding after shutdown', async () => {
    const logger = new CapturingLogger();
    const config = ConfigLoader.from({ logging: { level: 'debug' } }).get();
    const orch = await Orchestrator.fromConfig(config, { logger });

    await orch.shutdown();
    orch.events.emit('tool.call.start', {});
    expect(logger.entries).toHaveLength(0);
  });
});
