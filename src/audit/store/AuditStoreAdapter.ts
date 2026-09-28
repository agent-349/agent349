import type {
  AuditRecord,
  AuditQuery,
  AuditQueryResult,
  AggregateResult,
  AuditAggregateDimension,
} from '../../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// AuditStoreAdapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugable persistence adapter for the audit subsystem.
 *
 * Concrete implementations (Mongo, PostgreSQL, Elasticsearch, InMemory) extend
 * this class and provide the storage-specific logic for each method. The
 * {@link AuditLogger} depends only on this abstraction.
 *
 * ### Immutability Contract
 * Audit records must never be updated after insertion. Implementations should
 * enforce this at the database level where possible (e.g. PostgreSQL REVOKE
 * UPDATE, Mongo read-only users for update operations).
 *
 * ### Required Implementations
 * - {@link writeBatch} — persist a batch of records atomically.
 * - {@link query} — filter + paginate records.
 * - {@link getById} — point lookup by record UUID.
 * - {@link getByRequestId} — correlation lookup for a full request trace.
 * - {@link deleteOlderThan} — retention cleanup.
 * - {@link count} — count matching records.
 * - {@link aggregate} — grouped statistics.
 * - {@link healthCheck} — liveness probe.
 */
export abstract class AuditStoreAdapter {
  /** Human-readable identifier for the adapter (e.g. `'mongo'`, `'postgres'`). */
  abstract readonly name: string;

  /**
   * Writes a batch of audit records to the backing store.
   *
   * Implementations should treat this as an atomic operation: either all
   * records are persisted or none (within the limits of the store's
   * transaction support).
   *
   * @param records - Non-empty array of records to persist.
   */
  abstract writeBatch(records: AuditRecord[]): Promise<void>;

  /**
   * Queries the store with the given filters and returns a paginated result.
   *
   * @param query - Filter, sort, and pagination parameters.
   * @returns Matching records plus total count and pagination metadata.
   */
  abstract query(query: AuditQuery): Promise<AuditQueryResult>;

  /**
   * Retrieves a single audit record by its unique `id`.
   *
   * @param id - UUID of the record.
   * @returns The matching record, or `null` if not found.
   */
  abstract getById(id: string): Promise<AuditRecord | null>;

  /**
   * Retrieves all audit records that share the given `requestId`.
   *
   * Useful for reconstructing the full execution trace of a single agent
   * loop call.
   *
   * @param requestId - UUID of the originating request.
   * @returns All records for that request in insertion order.
   */
  abstract getByRequestId(requestId: string): Promise<AuditRecord[]>;

  /**
   * Deletes records older than `date`, optionally scoped to a single tenant.
   *
   * @param date     - Cutoff timestamp; records with `timestamp < date` are deleted.
   * @param tenantId - If provided, only delete records for this tenant.
   * @returns The number of records deleted.
   */
  abstract deleteOlderThan(date: Date, tenantId?: string): Promise<number>;

  /**
   * Counts records matching the given partial query.
   *
   * @param query - Partial filter (same fields as {@link AuditQuery} but all optional).
   * @returns Total matching record count.
   */
  abstract count(query: Partial<AuditQuery>): Promise<number>;

  /**
   * Returns aggregated statistics for a tenant over a time range, grouped by
   * the specified dimension.
   *
   * @param tenantId  - Tenant to aggregate.
   * @param dateRange - Inclusive time window.
   * @param groupBy   - Dimension to group by.
   * @returns Array of aggregated result buckets.
   */
  abstract aggregate(
    tenantId: string,
    dateRange: { from: Date; to: Date },
    groupBy: AuditAggregateDimension,
  ): Promise<AggregateResult[]>;

  /**
   * Checks whether the backing store is reachable and healthy.
   *
   * @returns `true` if the store is operational; `false` otherwise.
   */
  abstract healthCheck(): Promise<boolean>;

  /**
   * Releases any resources held by the store (connections, clients, timers).
   *
   * The default implementation is a no-op for in-process stores. Adapters that
   * hold external connections (e.g. MongoDB) override this and must be
   * idempotent. Called by `Orchestrator.shutdown()` for factory-owned stores.
   */
  close(): Promise<void> {
    // No-op by default.
    return Promise.resolve();
  }
}
