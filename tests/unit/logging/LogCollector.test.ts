import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../../src/events/EventBus.js';
import { LogCollector } from '../../../src/logging/LogCollector.js';
import { LoggerAdapter, type LogEntry } from '../../../src/logging/LoggerAdapter.js';

class CapturingLogger extends LoggerAdapter {
  readonly name = 'capturing';
  readonly entries: LogEntry[] = [];
  log(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

let bus: EventBus;
let logger: CapturingLogger;

beforeEach(() => {
  bus = new EventBus();
  logger = new CapturingLogger();
});

describe('LogCollector — level filtering', () => {
  it('drops entries below the configured minimum level', () => {
    const collector = new LogCollector(bus, logger, { level: 'warn' });
    collector.start();

    bus.emit('tool.call.start', {}); // debug → dropped
    bus.emit('agent.thinking', {}); // info → dropped
    bus.emit('security.acl.denied', {}); // warn → kept
    bus.emit('llm.call.error', {}); // error → kept

    expect(logger.entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('keeps everything at debug level', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug' });
    collector.start();
    bus.emit('tool.call.start', {});
    bus.emit('rag.search.end', {});
    expect(logger.entries).toHaveLength(2);
  });
});

describe('LogCollector — default classification', () => {
  it('maps event names to levels', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug' });
    collector.start();

    bus.emit('tool.call.error', {});
    bus.emit('approval.execution_failed', {});
    bus.emit('security.injection.detected', {});
    bus.emit('llm.call.start', {});
    bus.emit('memory.compress', {});

    const byEvent = Object.fromEntries(logger.entries.map((e) => [e.event, e.level]));
    expect(byEvent['tool.call.error']).toBe('error');
    expect(byEvent['approval.execution_failed']).toBe('error');
    expect(byEvent['security.injection.detected']).toBe('warn');
    expect(byEvent['llm.call.start']).toBe('debug');
    expect(byEvent['memory.compress']).toBe('info');
  });

  it('honours a custom classify function', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug', classify: () => 'error' });
    collector.start();
    bus.emit('anything.at.all', {});
    expect(logger.entries[0]!.level).toBe('error');
  });
});

describe('LogCollector — payload handling', () => {
  it('extracts _context and strips it from data', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug' });
    collector.start();
    bus.emit('tool.call.end', {
      toolName: 'echo',
      success: true,
      _context: { tenantId: 'acme', userId: 'u1' },
    });
    const entry = logger.entries[0]!;
    expect(entry.context).toEqual({ tenantId: 'acme', userId: 'u1' });
    expect(entry.data).toEqual({ toolName: 'echo', success: true });
  });

  it('omits data when includeData is false', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug', includeData: false });
    collector.start();
    bus.emit('tool.call.end', { toolName: 'echo' });
    expect(logger.entries[0]!.data).toBeUndefined();
  });

  it('redacts configured fields (deeply)', () => {
    const collector = new LogCollector(bus, logger, {
      level: 'debug',
      redactFields: ['password', 'token'],
    });
    collector.start();
    bus.emit('tool.call.end', {
      input: { user: 'bob', password: 'hunter2' },
      token: 'secret',
    });
    expect(logger.entries[0]!.data).toEqual({
      input: { user: 'bob', password: '[REDACTED]' },
      token: '[REDACTED]',
    });
  });
});

describe('LogCollector — lifecycle', () => {
  it('start() is idempotent (no duplicate entries)', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug' });
    collector.start();
    collector.start();
    bus.emit('tool.call.start', {});
    expect(logger.entries).toHaveLength(1);
  });

  it('stop() removes the subscription', () => {
    const collector = new LogCollector(bus, logger, { level: 'debug' });
    collector.start();
    expect(collector.active).toBe(true);
    collector.stop();
    expect(collector.active).toBe(false);
    bus.emit('tool.call.start', {});
    expect(logger.entries).toHaveLength(0);
  });

  it('a throwing logger does not break event dispatch', () => {
    class BrokenLogger extends LoggerAdapter {
      readonly name = 'broken';
      log(): void {
        throw new Error('sink down');
      }
    }
    const collector = new LogCollector(bus, new BrokenLogger(), { level: 'debug' });
    collector.start();
    let alsoCalled = false;
    bus.on('tool.call.start', () => {
      alsoCalled = true;
    });
    expect(() => bus.emit('tool.call.start', {})).not.toThrow();
    expect(alsoCalled).toBe(true);
  });
});
