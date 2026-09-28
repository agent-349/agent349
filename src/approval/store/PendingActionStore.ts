import type { PendingAction, PendingActionFilter } from '../../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// PendingActionStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugable persistence adapter for {@link PendingAction} objects.
 *
 * Concrete implementations (Mongo, PostgreSQL, Redis, InMemory) extend this
 * class. The {@link ApprovalService} depends only on this abstraction, keeping
 * the approval logic decoupled from any specific storage technology.
 *
 * ### State Transitions
 * ```
 * pending | escalated
 *   → executing       (via claimForExecution — MUST be atomic)
 *   → tool_completed  (tool OK + checkpoint exists)
 *   → resuming
 *   → completed | resume_failed
 *
 * executing → failed
 * pending | escalated → rejected | cancelled | expired
 * ```
 *
 * Only {@link update} and {@link claimForExecution} mutate state; every state
 * change must go through one of them so adapters can enforce consistency.
 */
export abstract class PendingActionStore {
  /** Human-readable identifier for the adapter (e.g. `'mongo'`, `'in-memory'`). */
  abstract readonly name: string;

  /**
   * Persists a newly created pending action.
   *
   * @param action - The complete action record to store.
   */
  abstract create(action: PendingAction): Promise<void>;

  /**
   * Retrieves a pending action by its UUID.
   *
   * @param id - Action UUID.
   * @returns The action, or `null` if not found.
   */
  abstract getById(id: string): Promise<PendingAction | null>;

  /**
   * Persists a mutated action record.
   *
   * Callers must treat the full `action` object as the source of truth; adapters
   * replace the stored record entirely (no partial-update semantics).
   *
   * @param action - Updated action (must have the same `id` as the stored record).
   */
  abstract update(action: PendingAction): Promise<void>;

  /**
   * Queries pending actions matching the given filter criteria.
   *
   * @param filter - Zero or more filter conditions (all applied with AND).
   * @returns Matching actions in the order determined by the adapter.
   */
  abstract getPending(filter: PendingActionFilter): Promise<PendingAction[]>;

  /**
   * Returns all actions whose `expiresAt` is in the past and whose status is
   * still `pending` or `escalated` (i.e. unresolved and overdue).
   *
   * @returns Expired-but-unresolved actions.
   */
  abstract getExpired(): Promise<PendingAction[]>;

  /**
   * Counts actions matching the partial filter.
   *
   * @param filter - Partial filter; all provided fields are ANDed.
   * @returns Total matching count.
   */
  abstract count(filter: Partial<PendingActionFilter>): Promise<number>;

  /**
   * Deletes resolved or expired actions older than `date` to reclaim storage.
   *
   * @param date - Records with `updatedAt < date` that are in a terminal state
   *   (`approved`, `rejected`, `expired`, `cancelled`, `completed`, `failed`,
   *   `resume_failed`) are deleted.
   * @returns The number of records deleted.
   */
  abstract deleteOlderThan(date: Date): Promise<number>;

  /**
   * Atomically transitions an action from `pending` or `escalated` → `executing`.
   *
   * This is the idempotency guard against concurrent approval requests. Only the
   * first caller succeeds; subsequent callers receive `null` and must abort.
   *
   * **Implementations MUST guarantee atomicity.** For MongoDB, use
   * `findOneAndUpdate`. For PostgreSQL, use `UPDATE … WHERE status IN
   * ('pending','escalated') RETURNING *`. The in-memory adapter relies on
   * JavaScript's single-threaded event loop — it is safe within a single
   * process but NOT across multiple processes or worker threads.
   *
   * @param actionId     - UUID of the action to claim.
   * @param approverInfo - Approver identity (for audit purposes).
   * @returns The mutated action with `status: 'executing'`, or `null` if the
   *          action does not exist or is already in a non-claimable state.
   */
  abstract claimForExecution(
    actionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    approverInfo: { userId: string; comment?: string; modifiedInput?: any },
  ): Promise<PendingAction | null>;
}
