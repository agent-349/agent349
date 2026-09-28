/**
 * Audit module types — records, queries, retention, export, and SIEM forwarding.
 *
 * Types shared across modules are canonically defined in `src/types/index.ts`
 * and re-exported here for intra-module convenience.
 *
 * `ForwardResult` is audit-exclusive (used only by SIEMForwarder) and is
 * defined below.
 */

// ─────────────────────────────────────────────────────────────────────────────
// RE-EXPORTS FROM SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type {
  AuditCategory,
  AuditRecord,
  AuditDetail,
  ToolCallLog,
  AuditQuery,
  AuditQueryResult,
  AggregateResult,
  AuditStats,
  RetentionPolicy,
  RetentionResult,
  ExportResult,
} from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// SIEM FORWARDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by a `SIEMForwarder` after attempting to deliver a batch
 * of audit records to an external SIEM system (Syslog, Webhook, Kafka, etc.).
 */
export interface ForwardResult {
  /** Number of records successfully delivered to the SIEM. */
  sent: number;
  /** Number of records that could not be delivered due to errors. */
  failed: number;
  /** Per-record or per-batch error messages for any failed deliveries. */
  errors?: string[];
}
