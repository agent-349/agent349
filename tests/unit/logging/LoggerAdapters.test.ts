import { describe, it, expect, vi, afterEach } from 'vitest';
import { NoopLoggerAdapter } from '../../../src/logging/NoopLoggerAdapter.js';
import { ConsoleLoggerAdapter } from '../../../src/logging/ConsoleLoggerAdapter.js';
import type { LogEntry } from '../../../src/logging/LoggerAdapter.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    message: 'tool.call.end',
    timestamp: new Date('2026-01-15T10:00:00Z'),
    event: 'tool.call.end',
    context: { tenantId: 'acme' },
    data: { toolName: 'echo' },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NoopLoggerAdapter', () => {
  it('discards entries and never throws', () => {
    const logger = new NoopLoggerAdapter();
    expect(logger.name).toBe('noop');
    expect(() => logger.log(makeEntry())).not.toThrow();
  });
});

describe('ConsoleLoggerAdapter', () => {
  it('routes each level to the matching console method', () => {
    const spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    };
    const logger = new ConsoleLoggerAdapter();
    logger.log(makeEntry({ level: 'debug' }));
    logger.log(makeEntry({ level: 'info' }));
    logger.log(makeEntry({ level: 'warn' }));
    logger.log(makeEntry({ level: 'error' }));

    expect(spies.debug).toHaveBeenCalledOnce();
    expect(spies.info).toHaveBeenCalledOnce();
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it('emits one JSON line by default with ISO timestamp', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    new ConsoleLoggerAdapter({ format: 'json' }).log(makeEntry());
    const arg = spy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg) as Record<string, unknown>;
    expect(parsed['event']).toBe('tool.call.end');
    expect(parsed['timestamp']).toBe('2026-01-15T10:00:00.000Z');
  });

  it('emits a human-readable prefix in pretty mode', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    new ConsoleLoggerAdapter({ format: 'pretty' }).log(makeEntry());
    const prefix = spy.mock.calls[0]![0] as string;
    expect(prefix).toContain('INFO');
    expect(prefix).toContain('tool.call.end');
  });
});
