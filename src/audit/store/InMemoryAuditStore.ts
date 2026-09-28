import type {
  AuditRecord,
  AuditQuery,
  AuditQueryResult,
  AggregateResult,
  AuditAggregateDimension,
} from '../../types/index.js';
import { AuditStoreAdapter } from './AuditStoreAdapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryAuditStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-process, non-persistent implementation of {@link AuditStoreAdapter}.
 *
 * Intended exclusively for unit testing and local development. All data is
 * lost when the process exits. Supports the full query, aggregate, and
 * retention API so that application code can be tested offline without any
 * external service.
 */
export class InMemoryAuditStore extends AuditStoreAdapter {
  readonly name = 'in-memory';

  readonly #records = new Map<string, AuditRecord>();

  // ─── Write ─────────────────────────────────────────────────────────────────

  async writeBatch(records: AuditRecord[]): Promise<void> {
    for (const record of records) {
      this.#records.set(record.id, record);
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<AuditRecord | null> {
    return this.#records.get(id) ?? null;
  }

  async getByRequestId(requestId: string): Promise<AuditRecord[]> {
    const result: AuditRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.requestId === requestId) result.push(record);
    }
    return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  async query(q: AuditQuery): Promise<AuditQueryResult> {
    let records = [...this.#records.values()];

    // ── Identity filters ──────────────────────────────────────────────────────
    if (q.tenantId !== undefined) records = records.filter((r) => r.tenantId === q.tenantId);
    if (q.userId !== undefined) records = records.filter((r) => r.userId === q.userId);
    if (q.agentId !== undefined) records = records.filter((r) => r.agentId === q.agentId);
    if (q.sessionId !== undefined) records = records.filter((r) => r.sessionId === q.sessionId);
    if (q.requestId !== undefined) records = records.filter((r) => r.requestId === q.requestId);

    // ── Event filters ─────────────────────────────────────────────────────────
    if (q.category !== undefined) {
      const cats = Array.isArray(q.category) ? q.category : [q.category];
      records = records.filter((r) => cats.includes(r.category));
    }
    if (q.action !== undefined) records = records.filter((r) => r.action === q.action);
    if (q.outcome !== undefined) {
      const outcomes = Array.isArray(q.outcome) ? q.outcome : [q.outcome];
      records = records.filter((r) => outcomes.includes(r.outcome));
    }
    if (q.severity !== undefined) {
      const sevs = Array.isArray(q.severity) ? q.severity : [q.severity];
      records = records.filter((r) => sevs.includes(r.severity));
    }

    // ── Time filter ───────────────────────────────────────────────────────────
    if (q.dateRange !== undefined) {
      records = records.filter(
        (r) =>
          r.timestamp.getTime() >= q.dateRange.from.getTime() &&
          r.timestamp.getTime() <= q.dateRange.to.getTime(),
      );
    }

    // ── Resource filters ──────────────────────────────────────────────────────
    if (q.resourceType !== undefined) {
      records = records.filter((r) => r.resource?.type === q.resourceType);
    }
    if (q.resourceId !== undefined) {
      records = records.filter((r) => r.resource?.id === q.resourceId);
    }

    // ── Text search ───────────────────────────────────────────────────────────
    if (q.searchText !== undefined) {
      const needle = q.searchText.toLowerCase();
      records = records.filter((r) => {
        const summary = r.detail?.summary ?? '';
        const error = r.detail?.error ?? '';
        return (
          summary.toLowerCase().includes(needle) ||
          error.toLowerCase().includes(needle) ||
          r.action.toLowerCase().includes(needle)
        );
      });
    }

    const total = records.length;

    // ── Sort ──────────────────────────────────────────────────────────────────
    const sortBy = q.sortBy ?? 'timestamp';
    const sortOrder = q.sortOrder ?? 'desc';
    const dir = sortOrder === 'asc' ? 1 : -1;

    records.sort((a, b) => {
      if (sortBy === 'severity') {
        const order = { info: 0, warning: 1, critical: 2 };
        return (order[a.severity] - order[b.severity]) * dir;
      }
      return (a.timestamp.getTime() - b.timestamp.getTime()) * dir;
    });

    // ── Pagination ────────────────────────────────────────────────────────────
    const limit = Math.min(q.limit ?? 50, 1000);
    const offset = q.offset ?? 0;
    const page = records.slice(offset, offset + limit);

    return {
      records: page,
      total,
      hasMore: offset + limit < total,
      query: q,
    };
  }

  // ─── Count ─────────────────────────────────────────────────────────────────

  async count(q: Partial<AuditQuery>): Promise<number> {
    let records = [...this.#records.values()];
    if (q.tenantId !== undefined) records = records.filter((r) => r.tenantId === q.tenantId);
    if (q.category !== undefined) {
      const cats = Array.isArray(q.category) ? q.category : [q.category];
      records = records.filter((r) => cats.includes(r.category));
    }
    if (q.outcome !== undefined) {
      const outcomes = Array.isArray(q.outcome) ? q.outcome : [q.outcome];
      records = records.filter((r) => outcomes.includes(r.outcome));
    }
    if (q.dateRange !== undefined) {
      records = records.filter(
        (r) =>
          r.timestamp.getTime() >= q.dateRange!.from.getTime() &&
          r.timestamp.getTime() <= q.dateRange!.to.getTime(),
      );
    }
    return records.length;
  }

  // ─── Aggregate ─────────────────────────────────────────────────────────────

  async aggregate(
    tenantId: string,
    dateRange: { from: Date; to: Date },
    groupBy: AuditAggregateDimension,
  ): Promise<AggregateResult[]> {
    const records = [...this.#records.values()].filter(
      (r) =>
        r.tenantId === tenantId &&
        r.timestamp.getTime() >= dateRange.from.getTime() &&
        r.timestamp.getTime() <= dateRange.to.getTime(),
    );

    const buckets = new Map<
      string,
      {
        count: number;
        totalDuration: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalCost: number;
        hasDuration: boolean;
      }
    >();

    for (const r of records) {
      const key = this.#groupKey(r, groupBy);
      const existing = buckets.get(key) ?? {
        count: 0,
        totalDuration: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalCost: 0,
        hasDuration: false,
      };
      existing.count++;
      if (r.metrics?.durationMs !== undefined) {
        existing.totalDuration += r.metrics.durationMs;
        existing.hasDuration = true;
      }
      if (r.metrics?.tokensInput !== undefined) existing.totalTokensInput += r.metrics.tokensInput;
      if (r.metrics?.tokensOutput !== undefined)
        existing.totalTokensOutput += r.metrics.tokensOutput;
      if (r.metrics?.estimatedCostUsd !== undefined)
        existing.totalCost += r.metrics.estimatedCostUsd;
      buckets.set(key, existing);
    }

    const results: AggregateResult[] = [];
    for (const [key, data] of buckets.entries()) {
      const totalTokens = data.totalTokensInput + data.totalTokensOutput;
      const result: AggregateResult = { key, count: data.count };
      if (data.hasDuration) result.avgDurationMs = data.totalDuration / data.count;
      if (totalTokens > 0) result.totalTokens = totalTokens;
      if (data.totalTokensInput > 0) result.totalTokensInput = data.totalTokensInput;
      if (data.totalTokensOutput > 0) result.totalTokensOutput = data.totalTokensOutput;
      if (data.totalCost > 0) result.totalCostUsd = data.totalCost;
      results.push(result);
    }

    return results.sort((a, b) => b.count - a.count);
  }

  // ─── Retention ─────────────────────────────────────────────────────────────

  async deleteOlderThan(date: Date, tenantId?: string): Promise<number> {
    let count = 0;
    for (const [id, record] of this.#records.entries()) {
      if (record.timestamp.getTime() < date.getTime()) {
        if (tenantId === undefined || record.tenantId === tenantId) {
          this.#records.delete(id);
          count++;
        }
      }
    }
    return count;
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  #groupKey(record: AuditRecord, groupBy: AuditAggregateDimension): string {
    switch (groupBy) {
      case 'category':
        return record.category;
      case 'action':
        return record.action;
      case 'outcome':
        return record.outcome;
      case 'severity':
        return record.severity;
      case 'user':
        return record.userId;
      case 'agent':
        return record.agentId;
      case 'hour': {
        const d = record.timestamp;
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
      }
      case 'day': {
        const d = record.timestamp;
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
    }
  }

  /** Total number of records in the store (for testing). */
  get recordCount(): number {
    return this.#records.size;
  }
}
