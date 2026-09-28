import type { EventBus } from '../events/EventBus.js';
import type { TokenTracker } from '../tokens/TokenTracker.js';
import type { AuditLogger } from '../audit/AuditLogger.js';
import type { AuditRecord, TokenUsageSummary } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Components that make up the observability surface. */
export interface ObservabilityDeps {
  /** The shared EventBus (live observability). */
  events: EventBus;
  /** Token consumption tracker (metrics plane). */
  tokens: TokenTracker;
  /** Audit logger (functional plane), or `undefined` when audit is disabled. */
  audit?: AuditLogger;
}

/** Cross-plane report for a single request. */
export interface RequestReport {
  /** The request these facts belong to. */
  requestId: string;
  /** Aggregated token usage and cost for the request. */
  usage: TokenUsageSummary;
  /** Immutable audit trail for the request (empty when audit is disabled). */
  auditTrail: AuditRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thin façade over the three observability planes — **technical logs** (via the
 * EventBus), **functional audit** (the audit logger) and **usage
 * metrics** (the token tracker).
 *
 * It does not own the components' lifecycle (the Orchestrator wires and tears
 * them down). Its value is unified access plus cross-cutting reads that would
 * otherwise require touching several planes — e.g. {@link getRequestReport}.
 */
export class Observability {
  readonly #events: EventBus;
  readonly #tokens: TokenTracker;
  readonly #audit: AuditLogger | undefined;

  constructor(deps: ObservabilityDeps) {
    this.#events = deps.events;
    this.#tokens = deps.tokens;
    this.#audit = deps.audit;
  }

  /** Live event stream. Subscribe with `observability.events.on(...)`. */
  get events(): EventBus {
    return this.#events;
  }

  /** Token consumption metrics (per tenant/user/agent/session/request). */
  get tokens(): TokenTracker {
    return this.#tokens;
  }

  /** Functional audit trail, or `undefined` when audit is disabled. */
  get audit(): AuditLogger | undefined {
    return this.#audit;
  }

  /**
   * Combines the cost and the audit trail of a single request into one report.
   *
   * @param requestId - The request to summarise.
   * @returns Usage (always) and the audit trail (empty if audit is disabled).
   */
  async getRequestReport(requestId: string): Promise<RequestReport> {
    const [usage, auditTrail] = await Promise.all([
      this.#tokens.getByRequest(requestId),
      this.#audit !== undefined ? this.#audit.getByRequestId(requestId) : Promise.resolve([]),
    ]);
    return { requestId, usage, auditTrail };
  }

  /**
   * Flushes buffered audit records to the store. No-op when audit is disabled.
   *
   * @returns The number of records flushed.
   */
  async flush(): Promise<number> {
    return this.#audit !== undefined ? this.#audit.flush() : 0;
  }
}
