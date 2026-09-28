import type { AuditRecord } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for {@link AuditWriteBuffer}. */
export interface AuditWriteBufferConfig {
  /**
   * Maximum number of records to accumulate before an automatic flush.
   * Default: `100`.
   */
  maxSize: number;
  /**
   * Milliseconds between periodic flushes driven by the internal timer.
   * Default: `5000`.
   */
  flushIntervalMs: number;
  /**
   * Called with the current batch when the buffer flushes.
   * Must persist the records. If it throws, the batch is reinserted at the
   * front of the buffer for the next flush attempt.
   */
  onFlush: (records: AuditRecord[]) => Promise<void>;
  /**
   * Called when `onFlush` throws so the caller can log or alert.
   * The failed batch is passed as the second argument.
   */
  onError: (error: Error, records: AuditRecord[]) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuditWriteBuffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory accumulation buffer for {@link AuditRecord} objects.
 *
 * Records are collected in an in-memory array and written to the store in
 * batches, either when the buffer reaches `maxSize` or when the periodic
 * timer fires. This decouples audit write latency from the hot path of the
 * agent loop.
 *
 * ### Error handling
 * If `onFlush` rejects, the failed batch is reinserted at the **front** of
 * the buffer (via `unshift`) so it will be retried on the next flush cycle.
 * `onError` is called so the host application can log or alert.
 *
 * ### Shutdown
 * Call {@link shutdown} during graceful shutdown to flush remaining records
 * and cancel the internal timer.
 */
export class AuditWriteBuffer {
  readonly #config: AuditWriteBufferConfig;
  #buffer: AuditRecord[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #flushing = false;

  /**
   * @param config - Buffer configuration including size limits and callbacks.
   */
  constructor(config: AuditWriteBufferConfig) {
    this.#config = config;
    this.#timer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs);
  }

  /**
   * Adds a record to the buffer.
   *
   * If adding the record causes the buffer to reach or exceed `maxSize`,
   * an immediate flush is triggered (fire-and-forget; errors are handled
   * by `onError`).
   *
   * @param record - The AuditRecord to buffer.
   */
  add(record: AuditRecord): void {
    this.#buffer.push(record);
    if (this.#buffer.length >= this.#config.maxSize) {
      void this.flush();
    }
  }

  /**
   * Flushes all buffered records to the store by calling `onFlush`.
   *
   * @returns The number of records successfully flushed, or `0` on error.
   */
  async flush(): Promise<number> {
    if (this.#buffer.length === 0) return 0;
    if (this.#flushing) return 0;

    this.#flushing = true;
    const batch = [...this.#buffer];
    this.#buffer = [];

    try {
      await this.#config.onFlush(batch);
      return batch.length;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.#config.onError(error, batch);
      // Reinsert at front for retry
      this.#buffer.unshift(...batch);
      return 0;
    } finally {
      this.#flushing = false;
    }
  }

  /**
   * Cancels the periodic flush timer and performs a final flush.
   *
   * Must be called during graceful application shutdown to avoid losing
   * buffered records.
   */
  async shutdown(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.flush();
  }

  /** Current number of records waiting in the buffer (for diagnostics). */
  get size(): number {
    return this.#buffer.length;
  }
}
