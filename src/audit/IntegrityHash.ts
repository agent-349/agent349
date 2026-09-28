import { createHash } from 'node:crypto';
import type { AuditRecord } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// IntegrityHash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes and verifies SHA-256 integrity hashes for {@link AuditRecord} objects.
 *
 * The hash covers the immutable identity fields of a record so that any
 * post-persistence tampering can be detected at query time.
 *
 * Covered fields: `id`, `timestamp`, `requestId`, `tenantId`, `userId`,
 * `category`, `action`, `outcome`.
 */
export class IntegrityHash {
  /**
   * Computes a SHA-256 hex digest over the immutable fields of `record`.
   *
   * @param record - The AuditRecord (or partial record containing all required fields).
   * @returns Lowercase hex SHA-256 string (64 characters).
   */
  compute(record: AuditRecord): string {
    const payload = JSON.stringify({
      id: record.id,
      timestamp: record.timestamp,
      requestId: record.requestId,
      tenantId: record.tenantId,
      userId: record.userId,
      category: record.category,
      action: record.action,
      outcome: record.outcome,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Verifies whether `record._integrityHash` matches the hash computed from
   * the record's immutable fields.
   *
   * @param record - The AuditRecord to verify.
   * @returns `true` if the stored hash matches; `false` if missing or mismatched.
   */
  verify(record: AuditRecord): boolean {
    if (record._integrityHash === undefined) return false;
    return record._integrityHash === this.compute(record);
  }
}
