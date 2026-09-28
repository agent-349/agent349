import { randomUUID } from 'node:crypto';
import type {
  AuditRecord,
  AuditCategory,
  AuditQuery,
  AuditQueryResult,
  AuditStats,
  RetentionPolicy,
  RetentionResult,
  ExportResult,
  ExecutionContext,
  AuditDetail,
} from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import { AuditStoreAdapter } from './store/AuditStoreAdapter.js';
import { AuditWriteBuffer } from './AuditWriteBuffer.js';
import { EventCollector } from './EventCollector.js';
import { IntegrityHash } from './IntegrityHash.js';
import { SensitiveDataGuard, type SensitiveDataGuardConfig } from './SensitiveDataGuard.js';
import { SIEMForwarder } from './siem/SIEMForwarder.js';
import { formatRecords } from './siem/formatters.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Buffer tuning options embedded in {@link AuditConfig}. */
export interface AuditBufferConfig {
  /** Max buffered records before an automatic flush. Default: 100. */
  maxSize?: number;
  /** Milliseconds between periodic flushes. Default: 5000. */
  flushIntervalMs?: number;
}

/**
 * Top-level configuration object for {@link AuditLogger}.
 */
export interface AuditConfig {
  /**
   * Global verbosity level.
   * - `'minimal'`  — correlation fields + outcome only.
   * - `'standard'` — adds sanitised inputs/outputs and token metrics.
   * - `'verbose'`  — adds full LLM messages and tool-call chain.
   * Default: `'standard'`.
   */
  verbosity?: 'minimal' | 'standard' | 'verbose';
  /**
   * Per-category verbosity overrides. Takes precedence over the global level.
   * Example: `{ security: 'verbose', memory: 'minimal' }`.
   */
  verbosityOverrides?: Partial<Record<AuditCategory, 'minimal' | 'standard' | 'verbose'>>;
  /** Buffer configuration for asynchronous writes. */
  buffer?: AuditBufferConfig;
  /**
   * Retention policy applied by {@link AuditLogger.applyRetention}.
   * When omitted a 90/90/365-day default is used.
   */
  retention?: Partial<RetentionPolicy>;
  /** Sensitive-data redaction configuration. */
  sensitiveData?: SensitiveDataGuardConfig & { enabled?: boolean };
}

/**
 * Renders one CSV cell.
 *
 * Object-valued fields (e.g. `detail`) are JSON-encoded rather than left to
 * `String()`, which would flatten every one of them to `[object Object]` and
 * silently drop the contents from the export.
 */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'symbol') return value.toString();
  return String(value as string | number | boolean | bigint);
}

// ─────────────────────────────────────────────────────────────────────────────
// AuditLogger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central service for the audit subsystem.
 *
 * Provides:
 * - **Manual logging** via {@link log} and {@link logSecurity}.
 * - **Automatic capture** of EventBus events via {@link startAutoCapture}.
 * - **Buffered writes** through {@link AuditWriteBuffer} to avoid blocking the
 *   agent loop.
 * - **Sensitive-data redaction** before records reach the store.
 * - **Integrity hashing** for tamper detection.
 * - **Query API** delegated to the backing {@link AuditStoreAdapter}.
 * - **Retention management** via {@link applyRetention}.
 * - **Export** stubs for JSON/CSV/SIEM (not implemented in the InMemory path).
 *
 * ### Example
 * ```typescript
 * const logger = new AuditLogger(store, eventBus, { verbosity: 'standard' });
 * logger.startAutoCapture();
 *
 * // Manual log
 * await logger.log({
 *   tenantId: 'acme', userId: 'u1', agentId: 'agent-01',
 *   category: 'system', action: 'config_changed',
 *   outcome: 'success', severity: 'warning',
 * });
 * ```
 */
export class AuditLogger {
  readonly #store: AuditStoreAdapter;
  readonly #config: AuditConfig;
  readonly #buffer: AuditWriteBuffer;
  readonly #collector: EventCollector;
  readonly #integrityHash: IntegrityHash;
  readonly #guard: SensitiveDataGuard | undefined;
  readonly #forwarder: SIEMForwarder | undefined;

  /**
   * @param store     - Plugable store adapter (Mongo, Postgres, InMemory, …).
   * @param eventBus  - Shared event bus used for auto-capture.
   * @param config    - Verbosity, buffer, retention, and data-guard settings.
   * @param forwarder - Optional SIEM forwarder. When set, every flushed batch is
   *                    shipped to it after a successful store write.
   */
  constructor(
    store: AuditStoreAdapter,
    eventBus: EventBus,
    config: AuditConfig = {},
    forwarder?: SIEMForwarder,
  ) {
    this.#store = store;
    this.#config = config;
    this.#forwarder = forwarder;
    this.#integrityHash = new IntegrityHash();

    const sensitiveConfig = config.sensitiveData;
    if (sensitiveConfig?.enabled !== false) {
      this.#guard = new SensitiveDataGuard({
        ...(sensitiveConfig?.globalRedactFields !== undefined && {
          globalRedactFields: sensitiveConfig.globalRedactFields,
        }),
        ...(sensitiveConfig?.customPatterns !== undefined && {
          customPatterns: sensitiveConfig.customPatterns,
        }),
      });
    }

    this.#buffer = new AuditWriteBuffer({
      maxSize: config.buffer?.maxSize ?? 100,
      flushIntervalMs: config.buffer?.flushIntervalMs ?? 5000,
      onFlush: async (records): Promise<void> => {
        await this.#store.writeBatch(records);
        // Forward to the SIEM after a durable write. A forwarding failure must
        // not fail the flush (records are already persisted), so it is isolated.
        if (this.#forwarder !== undefined) {
          try {
            await this.#forwarder.forward(records);
          } catch {
            // SIEM delivery is best-effort; never break the audit pipeline.
          }
        }
      },
      onError: (_error, _records): void => {
        // Silent by contract: the SDK writes nothing to stdout. Callers observe
        // store failures by subscribing to the EventBus instead.
      },
    });

    this.#collector = new EventCollector(eventBus, (partial) => {
      void this.log(partial);
    });
  }

  // ─── Write API ──────────────────────────────────────────────────────────────

  /**
   * Records a single audit event.
   *
   * Missing required fields default to empty strings so that partial records
   * from auto-capture can be logged without the caller knowing the full context.
   *
   * @param partial - Partial AuditRecord. `id` and `timestamp` are always generated.
   * @returns The generated `id` of the persisted record.
   */
  async log(partial: Partial<AuditRecord>): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    const record: AuditRecord = {
      id,
      timestamp: now,
      requestId: partial.requestId ?? '',
      sessionId: partial.sessionId ?? '',
      tenantId: partial.tenantId ?? '',
      userId: partial.userId ?? '',
      agentId: partial.agentId ?? '',
      category: partial.category ?? 'system',
      action: partial.action ?? 'unknown',
      outcome: partial.outcome ?? 'success',
      severity: partial.severity ?? 'info',
      ...(partial.detail !== undefined &&
        ((): Record<string, unknown> => {
          const d = this.#applyVerbosity(partial);
          return d !== undefined ? { detail: d } : {};
        })()),
      ...(partial.resource !== undefined && { resource: partial.resource }),
      ...(partial.metrics !== undefined && { metrics: partial.metrics }),
      ...(partial.security !== undefined && { security: partial.security }),
    };

    // Compute integrity hash over immutable fields
    record._integrityHash = this.#integrityHash.compute(record);

    // Redact sensitive data
    const sanitized = this.#guard !== undefined ? this.#guard.sanitize(record) : record;

    this.#buffer.add(sanitized);
    return id;
  }

  /**
   * Convenience shortcut for security-category events.
   *
   * @param action  - Action name (e.g. `'access_denied'`).
   * @param context - ExecutionContext providing correlation fields.
   * @param detail  - Optional AuditDetail block.
   * @returns The generated record `id`.
   */
  async logSecurity(
    action: string,
    context: ExecutionContext,
    detail: Partial<AuditDetail> = {},
  ): Promise<string> {
    return this.log({
      requestId: context.requestId,
      sessionId: context.sessionId,
      tenantId: context.tenantId,
      userId: context.userId,
      agentId: context.agentId,
      category: 'security',
      action,
      outcome: 'blocked',
      severity: 'warning',
      detail,
    });
  }

  /**
   * Forces an immediate flush of all buffered records to the store.
   *
   * @returns The number of records flushed.
   */
  async flush(): Promise<number> {
    return this.#buffer.flush();
  }

  // ─── Read API ───────────────────────────────────────────────────────────────

  /**
   * Queries the audit store with the given filters.
   *
   * @param query - Filter, sort, and pagination options.
   */
  async query(query: AuditQuery): Promise<AuditQueryResult> {
    return this.#store.query(query);
  }

  /**
   * Retrieves a single record by its UUID.
   *
   * @param id - Record UUID.
   * @returns The record or `null` if not found.
   */
  async getById(id: string): Promise<AuditRecord | null> {
    return this.#store.getById(id);
  }

  /**
   * Returns all records that share a `requestId`, sorted chronologically.
   *
   * @param requestId - UUID of the originating request.
   */
  async getByRequestId(requestId: string): Promise<AuditRecord[]> {
    return this.#store.getByRequestId(requestId);
  }

  /**
   * Returns the full chronological timeline of a session.
   *
   * @param sessionId - Session identifier.
   */
  async getSessionTimeline(sessionId: string): Promise<AuditRecord[]> {
    const now = new Date();
    const epoch = new Date(0);
    const result = await this.#store.query({
      sessionId,
      dateRange: { from: epoch, to: now },
      sortBy: 'timestamp',
      sortOrder: 'asc',
      limit: 1000,
    });
    return result.records;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  /**
   * Returns aggregated statistics for a tenant over a date range.
   *
   * @param tenantId  - Tenant to analyse.
   * @param dateRange - Inclusive time window.
   */
  async getStats(tenantId: string, dateRange: { from: Date; to: Date }): Promise<AuditStats> {
    const [byCategory, byOutcome, bySeverity, byUserAgg, byAgentAgg, total] = await Promise.all([
      this.#store.aggregate(tenantId, dateRange, 'category'),
      this.#store.aggregate(tenantId, dateRange, 'outcome'),
      this.#store.aggregate(tenantId, dateRange, 'severity'),
      this.#store.aggregate(tenantId, dateRange, 'user'),
      this.#store.aggregate(tenantId, dateRange, 'agent'),
      this.#store.count({ tenantId, dateRange }),
    ]);

    const byCategoryMap: Record<string, number> = {};
    let totalTokensInput = 0;
    let totalTokensOutput = 0;
    let totalCostUsd = 0;
    let agentLoopAvgMs = 0;
    for (const r of byCategory) {
      byCategoryMap[r.key] = r.count;
      totalTokensInput += r.totalTokensInput ?? 0;
      totalTokensOutput += r.totalTokensOutput ?? 0;
      totalCostUsd += r.totalCostUsd ?? 0;
      // Agent-loop records carry the end-to-end response time.
      if (r.key === 'agent' && r.avgDurationMs !== undefined) agentLoopAvgMs = r.avgDurationMs;
    }

    const byOutcomeMap: Record<string, number> = {};
    for (const r of byOutcome) byOutcomeMap[r.key] = r.count;

    const bySeverityMap: Record<string, number> = {};
    for (const r of bySeverity) bySeverityMap[r.key] = r.count;

    const byUser = byUserAgg.map((r) => ({
      userId: r.key,
      count: r.count,
      tokens: r.totalTokens ?? 0,
    }));
    const byAgent = byAgentAgg.map((r) => ({
      agentId: r.key,
      count: r.count,
      tokens: r.totalTokens ?? 0,
    }));

    return {
      totalRecords: total,
      byCategory: byCategoryMap,
      byOutcome: byOutcomeMap,
      bySeverity: bySeverityMap,
      byUser,
      byAgent,
      totalTokensInput,
      totalTokensOutput,
      totalCostUsd,
      avgResponseTimeMs: agentLoopAvgMs,
      securityIncidents: byCategoryMap['security'] ?? 0,
    };
  }

  // ─── Export (stubs) ─────────────────────────────────────────────────────────

  /**
   * Exports matching records as newline-delimited JSON to the given path.
   * @returns Export metadata.
   */
  async exportJSON(query: AuditQuery, outputPath: string): Promise<ExportResult> {
    const result = await this.#store.query({ ...query, limit: 1000 });
    const start = Date.now();
    const content = JSON.stringify(result.records, null, 2);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, content, 'utf8');
    return {
      recordsExported: result.records.length,
      filePath: outputPath,
      fileSizeBytes: Buffer.byteLength(content, 'utf8'),
      format: 'json',
      durationMs: Date.now() - start,
      dateRange: query.dateRange,
    };
  }

  /**
   * Exports matching records as CSV to the given path.
   * @returns Export metadata.
   */
  async exportCSV(query: AuditQuery, outputPath: string): Promise<ExportResult> {
    const result = await this.#store.query({ ...query, limit: 1000 });
    const start = Date.now();
    const headers = [
      'id',
      'timestamp',
      'tenantId',
      'userId',
      'agentId',
      'category',
      'action',
      'outcome',
      'severity',
    ];
    const rows = result.records.map((r) =>
      headers.map((h) => csvCell((r as unknown as Record<string, unknown>)[h])).join(','),
    );
    const content = [headers.join(','), ...rows].join('\n');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, content, 'utf8');
    return {
      recordsExported: result.records.length,
      filePath: outputPath,
      fileSizeBytes: Buffer.byteLength(content, 'utf8'),
      format: 'csv',
      durationMs: Date.now() - start,
      dateRange: query.dateRange,
    };
  }

  /**
   * Exports matching records in a SIEM format (CEF, LEEF, or JSON) to the given path.
   * @returns Export metadata.
   */
  async exportSIEM(
    query: AuditQuery,
    format: 'cef' | 'leef' | 'json',
    outputPath: string,
  ): Promise<ExportResult> {
    const result = await this.#store.query({ ...query, limit: 1000 });
    const start = Date.now();
    // Shared formatters keep file export and live SIEM forwarding consistent.
    const content = formatRecords(result.records, format);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputPath, content, 'utf8');
    return {
      recordsExported: result.records.length,
      filePath: outputPath,
      fileSizeBytes: Buffer.byteLength(content, 'utf8'),
      format,
      durationMs: Date.now() - start,
      dateRange: query.dateRange,
    };
  }

  // ─── Retention ──────────────────────────────────────────────────────────────

  /**
   * Applies the configured retention policy by deleting expired records.
   *
   * @returns Summary of deleted and archived counts.
   */
  async applyRetention(): Promise<RetentionResult> {
    const policy = this.#config.retention;
    const defaultDays = policy?.default ?? 90;
    const cutoff = new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);
    const start = Date.now();
    const deleted = await this.#store.deleteOlderThan(cutoff);
    return {
      recordsDeleted: deleted,
      recordsArchived: 0,
      spaceFreedMb: 0,
      duration: Date.now() - start,
    };
  }

  // ─── Auto-capture lifecycle ─────────────────────────────────────────────────

  /**
   * Starts automatic capture of all auditable EventBus events.
   *
   * Idempotent — calling this multiple times resets and restarts the collector.
   */
  startAutoCapture(): void {
    this.#collector.start();
  }

  /**
   * Stops automatic capture and flushes any remaining buffered records.
   *
   * Call this during graceful application shutdown.
   */
  async stopAutoCapture(): Promise<void> {
    this.#collector.stop();
    await this.#buffer.shutdown();
    // Buffer is now flushed (final batch forwarded); release the forwarder.
    if (this.#forwarder !== undefined) await this.#forwarder.close();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Applies the effective verbosity level for a record's category, stripping
   * detail fields that exceed the configured level.
   */
  #applyVerbosity(partial: Partial<AuditRecord>): AuditDetail | undefined {
    if (partial.detail === undefined) return undefined;

    const category = partial.category ?? 'system';
    const effectiveLevel =
      this.#config.verbosityOverrides?.[category] ?? this.#config.verbosity ?? 'standard';

    const { summary, input, output, error, messages, fullResponse, toolCallChain } = partial.detail;

    if (effectiveLevel === 'minimal') {
      return {
        ...(summary !== undefined && { summary }),
      };
    }

    if (effectiveLevel === 'standard') {
      return {
        ...(summary !== undefined && { summary }),
        ...(input !== undefined && { input }),
        ...(output !== undefined && { output }),
        ...(error !== undefined && { error }),
      };
    }

    // verbose — include everything
    return {
      ...(summary !== undefined && { summary }),
      ...(input !== undefined && { input }),
      ...(output !== undefined && { output }),
      ...(error !== undefined && { error }),
      ...(messages !== undefined && { messages }),
      ...(fullResponse !== undefined && { fullResponse }),
      ...(toolCallChain !== undefined && { toolCallChain }),
    };
  }
}
