import type { PendingAction, PendingActionFilter, PendingActionStatus } from '../../types/index.js';
import { PendingActionStore } from './PendingActionStore.js';

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryPendingStore
// ─────────────────────────────────────────────────────────────────────────────

/** Terminal statuses — actions in these states are eligible for cleanup. */
const TERMINAL_STATUSES: PendingActionStatus[] = [
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'completed',
  'failed',
  'resume_failed',
];

/**
 * In-process, non-persistent implementation of {@link PendingActionStore}.
 *
 * ⚠️  **NOT suitable for production deployments.**
 *
 * - All data is lost when the process exits. Pending approvals created in one
 *   process cannot be seen or resolved by a different process (e.g. a
 *   horizontally-scaled API cluster).
 * - `claimForExecution()` atomicity relies on Node.js's single-threaded event
 *   loop. It is **not safe across multiple Node.js processes or worker threads**
 *   — two processes can both pass the status check and both execute the tool.
 *
 * For production deployments use {@link MongoPendingActionStore} (or a
 * PostgreSQL / Redis equivalent that enforces database-level atomicity).
 *
 * Supports the full query and lifecycle API so that application code and tests
 * can run entirely offline without external services.
 */
export class InMemoryPendingStore extends PendingActionStore {
  readonly name = 'in-memory';

  readonly #store = new Map<string, PendingAction>();

  // ─── Write ─────────────────────────────────────────────────────────────────

  async create(action: PendingAction): Promise<void> {
    this.#store.set(action.id, { ...action });
  }

  async update(action: PendingAction): Promise<void> {
    this.#store.set(action.id, { ...action });
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<PendingAction | null> {
    return this.#store.get(id) ?? null;
  }

  async getPending(filter: PendingActionFilter): Promise<PendingAction[]> {
    let records = [...this.#store.values()];

    // ── Status filter ─────────────────────────────────────────────────────────
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter((r) => statuses.includes(r.status));
    }

    // ── Identity filters ──────────────────────────────────────────────────────
    if (filter.tenantId !== undefined) {
      records = records.filter((r) => r.tenantId === filter.tenantId);
    }
    if (filter.requestedBy !== undefined) {
      records = records.filter((r) => r.requestedBy === filter.requestedBy);
    }
    if (filter.requestId !== undefined) {
      records = records.filter((r) => r.requestId === filter.requestId);
    }
    if (filter.agentId !== undefined) {
      records = records.filter((r) => r.agentId === filter.agentId);
    }
    if (filter.risk !== undefined) {
      records = records.filter((r) => r.risk === filter.risk);
    }

    // ── Approver roles filter — action must be addressable by at least one role ─
    if (filter.approverRoles !== undefined && filter.approverRoles.length > 0) {
      records = records.filter((r) =>
        filter.approverRoles!.some((role) => r.approverRoles.includes(role)),
      );
    }

    // ── Date filters ──────────────────────────────────────────────────────────
    if (filter.createdAfter !== undefined) {
      records = records.filter((r) => r.createdAt.getTime() >= filter.createdAfter!.getTime());
    }
    if (filter.createdBefore !== undefined) {
      records = records.filter((r) => r.createdAt.getTime() <= filter.createdBefore!.getTime());
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    const sortBy = filter.sortBy ?? 'createdAt';
    records.sort((a, b) => {
      switch (sortBy) {
        case 'expiresAt':
          return a.expiresAt.getTime() - b.expiresAt.getTime();
        case 'risk':
          return riskOrder[b.risk] - riskOrder[a.risk]; // highest risk first
        default: // 'createdAt'
          return b.createdAt.getTime() - a.createdAt.getTime(); // newest first
      }
    });

    // ── Limit ─────────────────────────────────────────────────────────────────
    if (filter.limit !== undefined) {
      records = records.slice(0, filter.limit);
    }

    return records;
  }

  async getExpired(): Promise<PendingAction[]> {
    const now = Date.now();
    return [...this.#store.values()].filter(
      (r) => r.expiresAt.getTime() < now && (r.status === 'pending' || r.status === 'escalated'),
    );
  }

  // ─── Count ─────────────────────────────────────────────────────────────────

  async count(filter: Partial<PendingActionFilter>): Promise<number> {
    let records = [...this.#store.values()];
    if (filter.tenantId !== undefined) {
      records = records.filter((r) => r.tenantId === filter.tenantId);
    }
    if (filter.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter((r) => statuses.includes(r.status));
    }
    return records.length;
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  async deleteOlderThan(date: Date): Promise<number> {
    let count = 0;
    for (const [id, action] of this.#store.entries()) {
      if (
        TERMINAL_STATUSES.includes(action.status) &&
        action.updatedAt.getTime() < date.getTime()
      ) {
        this.#store.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Atomically claims the action for execution within a single Node.js process.
   *
   * The synchronous get-then-set is safe because JavaScript's event loop is
   * single-threaded: no other code can run between the two lines.
   *
   * ⚠️  Not safe across multiple processes or worker threads — see class-level
   * warning. Use {@link MongoPendingActionStore} for multi-process deployments.
   */
  async claimForExecution(
    actionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _approverInfo: { userId: string; comment?: string; modifiedInput?: any },
  ): Promise<PendingAction | null> {
    const action = this.#store.get(actionId);
    if (action === undefined) return null;
    if (action.status !== 'pending' && action.status !== 'escalated') return null;
    // Synchronous get + set: no await between = atomic within a single process.
    const claimed: PendingAction = { ...action, status: 'executing', updatedAt: new Date() };
    this.#store.set(actionId, claimed);
    return claimed;
  }

  /** Total number of stored actions (for testing). */
  get size(): number {
    return this.#store.size;
  }
}
