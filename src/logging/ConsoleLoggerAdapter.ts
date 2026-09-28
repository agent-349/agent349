import { LoggerAdapter, type LogEntry, type LogLevel } from './LoggerAdapter.js';

/** Output format for {@link ConsoleLoggerAdapter}. */
export type ConsoleLogFormat = 'json' | 'pretty';

/** Configuration for {@link ConsoleLoggerAdapter}. */
export interface ConsoleLoggerAdapterConfig {
  /** `'json'` (default) emits one JSON object per line; `'pretty'` is human-readable. */
  format?: ConsoleLogFormat;
}

/** Maps a log level to the matching `console` method. */
const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/**
 * A {@link LoggerAdapter} that writes to the console.
 *
 * This is the **only** component in the SDK permitted to call `console`, and it
 * lives outside `core/`. It is never wired by default — applications must select
 * the `console` logging adapter explicitly.
 */
export class ConsoleLoggerAdapter extends LoggerAdapter {
  readonly name = 'console';
  readonly #format: ConsoleLogFormat;

  constructor(config: ConsoleLoggerAdapterConfig = {}) {
    super();
    this.#format = config.format ?? 'json';
  }

  log(entry: LogEntry): void {
    const method = CONSOLE_METHOD[entry.level];

    if (this.#format === 'json') {
      // eslint-disable-next-line no-console
      console[method](JSON.stringify({ ...entry, timestamp: entry.timestamp.toISOString() }));
      return;
    }

    const ts = entry.timestamp.toISOString();
    const ev = entry.event !== undefined ? ` ${entry.event}` : '';
    const prefix = `[${ts}] ${entry.level.toUpperCase()}${ev}: ${entry.message}`;
    const extras =
      entry.data !== undefined || entry.context !== undefined
        ? {
            ...(entry.context !== undefined && { context: entry.context }),
            ...(entry.data !== undefined && { data: entry.data }),
          }
        : undefined;

    if (extras !== undefined) {
      // eslint-disable-next-line no-console
      console[method](prefix, extras);
    } else {
      // eslint-disable-next-line no-console
      console[method](prefix);
    }
  }
}
