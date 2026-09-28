import { LoggerAdapter, type LogEntry } from './LoggerAdapter.js';

/**
 * The default {@link LoggerAdapter}: discards every entry.
 *
 * Keeps the SDK silent unless an application explicitly opts into logging,
 * honouring the rule that the SDK prints nothing to stdout by itself.
 */
export class NoopLoggerAdapter extends LoggerAdapter {
  readonly name = 'noop';

  log(_entry: LogEntry): void {
    // Intentionally does nothing.
  }
}
