import type { AuditRecord } from '../../types/index.js';
import type { ForwardResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// SIEMForwarder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugable real-time forwarder that ships audit records to an external SIEM
 * (Splunk, QRadar, Elastic, a webhook, syslog, …).
 *
 * Unlike `AuditLogger.exportSIEM` (a one-off file dump), a forwarder is invoked
 * for **every flushed batch** so the SIEM receives records as they happen. The
 * `AuditLogger` calls {@link forward} after a batch is durably written to the
 * store; a forwarding failure never blocks or fails the store write.
 *
 * Implementations must not throw from {@link forward} — surface delivery
 * problems through the returned {@link ForwardResult} instead.
 */
export abstract class SIEMForwarder {
  /** Human-readable identifier (e.g. `'webhook'`, `'syslog'`). */
  abstract readonly name: string;

  /**
   * Delivers a batch of records to the SIEM.
   *
   * @param records - Non-empty batch of records to forward.
   * @returns Counts of delivered/failed records and any error messages.
   */
  abstract forward(records: AuditRecord[]): Promise<ForwardResult>;

  /**
   * Releases any held resources (sockets, agents). Default is a no-op.
   * Idempotent in implementations that hold connections.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
