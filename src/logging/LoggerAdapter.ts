// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Technical log severity, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric ordering used to compare levels against a configured threshold. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Correlation fields carried by an event's `_context`. */
export interface LogContext {
  tenantId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  requestId?: string;
}

/**
 * A single structured log entry forwarded to a {@link LoggerAdapter}.
 *
 * Produced by the {@link LogCollector} from EventBus events. This is the
 * **technical** observability plane — distinct from the immutable audit trail
 * and the token-consumption metrics.
 */
export interface LogEntry {
  /** Severity of the entry. */
  level: LogLevel;
  /** Short human-readable message (defaults to the originating event name). */
  message: string;
  /** UTC timestamp when the entry was produced. */
  timestamp: Date;
  /** Name of the EventBus event that produced this entry, when applicable. */
  event?: string;
  /** Correlation fields extracted from the event's `_context`. */
  context?: LogContext;
  /** Remaining event payload (with `_context` stripped), optionally redacted. */
  data?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoggerAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugable sink for technical log entries.
 *
 * The SDK never writes to stdout on its own: the default adapter is
 * {@link NoopLoggerAdapter}. Applications opt into output by configuring the
 * `console` adapter or by injecting a custom adapter (e.g. pino, winston, Loki)
 * via `Orchestrator` overrides.
 *
 * `log()` is synchronous and must never throw — the {@link LogCollector} runs it
 * on the EventBus hot path. Adapters that talk to a remote backend should buffer
 * internally and flush asynchronously.
 */
export abstract class LoggerAdapter {
  /** Human-readable identifier for the adapter (e.g. `'console'`, `'noop'`). */
  abstract readonly name: string;

  /**
   * Writes a single log entry. Implementations must not throw.
   *
   * @param entry - The structured entry to emit.
   */
  abstract log(entry: LogEntry): void;
}
