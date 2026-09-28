import type { AgentEvent } from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import {
  LoggerAdapter,
  LOG_LEVEL_ORDER,
  type LogEntry,
  type LogLevel,
  type LogContext,
} from './LoggerAdapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for {@link LogCollector}. */
export interface LogCollectorConfig {
  /** Minimum level to forward. Entries below this are dropped. Default: `'info'`. */
  level?: LogLevel;
  /**
   * Include the event payload (with `_context` stripped) in `entry.data`.
   * Default: `true`.
   */
  includeData?: boolean;
  /**
   * Field names whose values are replaced with `'[REDACTED]'` anywhere in the
   * payload before logging. Use to keep PII / secrets out of technical logs.
   */
  redactFields?: string[];
  /**
   * Override the default event → level classifier.
   * Return the level an event should be logged at.
   */
  classify?: (event: string, data: Record<string, unknown>) => LogLevel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default mapping from an event name to a {@link LogLevel}:
 * - `*.error` / `*failed*`        → `error`
 * - `security.*`                  → `warn`
 * - `*.start` / `*.end` / progress→ `debug`
 * - everything else               → `info`
 */
function defaultClassify(event: string): LogLevel {
  if (event.endsWith('.error') || event.includes('fail')) return 'error';
  if (event.startsWith('security.')) return 'warn';
  if (
    event.endsWith('.start') ||
    event.endsWith('.end') ||
    event.includes('progress') ||
    event.includes('chunk')
  ) {
    return 'debug';
  }
  return 'info';
}

// ─────────────────────────────────────────────────────────────────────────────
// LogCollector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribes to every EventBus event and forwards a structured {@link LogEntry}
 * to a {@link LoggerAdapter}, filtered by the configured minimum level.
 *
 * This is the technical-observability bridge: it owns its subscription so it can
 * be cleanly torn down (e.g. on `Orchestrator.shutdown()`). It never persists
 * anything — persistence is the adapter's concern.
 */
export class LogCollector {
  readonly #bus: EventBus;
  readonly #logger: LoggerAdapter;
  readonly #minLevel: number;
  readonly #includeData: boolean;
  readonly #redactFields: Set<string>;
  readonly #classify: (event: string, data: Record<string, unknown>) => LogLevel;
  #handler: ((event: AgentEvent) => void) | undefined;

  constructor(bus: EventBus, logger: LoggerAdapter, config: LogCollectorConfig = {}) {
    this.#bus = bus;
    this.#logger = logger;
    this.#minLevel = LOG_LEVEL_ORDER[config.level ?? 'info'];
    this.#includeData = config.includeData ?? true;
    this.#redactFields = new Set(config.redactFields ?? []);
    this.#classify = config.classify ?? defaultClassify;
  }

  /**
   * Starts forwarding events. Idempotent — calling `start()` when already active
   * first calls `stop()` to reset the subscription.
   */
  start(): void {
    this.stop();

    const handler = (event: AgentEvent): void => {
      const level = this.#classify(event.type, event.data);
      if (LOG_LEVEL_ORDER[level] < this.#minLevel) return;

      const { _context, ...rest } = event.data as Record<string, unknown> & {
        _context?: LogContext;
      };

      const entry: LogEntry = {
        level,
        message: event.type,
        timestamp: event.timestamp,
        event: event.type,
        ...(_context !== undefined && { context: _context }),
        ...(this.#includeData &&
          Object.keys(rest).length > 0 && {
            data: this.#redact(rest) as Record<string, unknown>,
          }),
      };

      // The logger must never throw, but guard the hot path defensively.
      try {
        this.#logger.log(entry);
      } catch {
        // Swallow: a broken logger must not break event dispatch.
      }
    };

    this.#handler = handler;
    this.#bus.on('*', handler);
  }

  /** Removes the EventBus subscription. */
  stop(): void {
    if (this.#handler !== undefined) {
      this.#bus.off('*', this.#handler);
      this.#handler = undefined;
    }
  }

  /** Whether the collector is currently subscribed. */
  get active(): boolean {
    return this.#handler !== undefined;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  #redact(value: unknown): unknown {
    if (this.#redactFields.size === 0) return value;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => this.#redact(v));

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = this.#redactFields.has(k) ? '[REDACTED]' : this.#redact(v);
    }
    return result;
  }
}
