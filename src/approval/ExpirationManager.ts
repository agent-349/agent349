import type { ApprovalTrigger, ExpirationPolicy } from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import type { PendingActionStore } from './store/PendingActionStore.js';
import type { ApprovalNotifier } from './notification/ApprovalNotifier.js';
import type { ToolExecutor } from '../tools/ToolExecutor.js';

// ─────────────────────────────────────────────────────────────────────────────
// ExpirationManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles automatic expiration of pending actions that have passed their
 * `expiresAt` deadline without being resolved.
 *
 * Depending on the {@link ExpirationPolicy}, expired actions are either:
 * - Marked `expired` (default safe behaviour).
 * - Auto-rejected with a system `rejection` resolution.
 * - Auto-approved and executed immediately (only for `low` risk actions; the
 *   manager skips auto-approve for higher risk levels).
 *
 * ### Scheduling
 * Like {@link EscalationManager}, the host application must call {@link process}
 * periodically. The SDK does not self-schedule.
 *
 * @example
 * ```typescript
 * const mgr = new ExpirationManager(store, notifier, bus, {
 *   onExpire: 'expire',
 *   notifyRequestor: true,
 *   notifyApprovers: true,
 *   checkIntervalMs: 60_000,
 * });
 * setInterval(() => mgr.process(triggers), mgr.checkIntervalMs);
 * ```
 */
export class ExpirationManager {
  readonly #store: PendingActionStore;
  readonly #notifier: ApprovalNotifier;
  readonly #bus: EventBus;
  readonly #policy: ExpirationPolicy;
  readonly #toolExecutor: ToolExecutor | undefined;

  /** Exposes `checkIntervalMs` so callers can schedule correctly. */
  get checkIntervalMs(): number {
    return this.#policy.checkIntervalMs;
  }

  /**
   * @param store        - Pending action store for reading and updating records.
   * @param notifier     - Notifier for alerting parties on expiry.
   * @param eventBus     - Event bus for broadcasting expiry events.
   * @param policy       - Expiration behaviour configuration.
   * @param toolExecutor - Required only when `policy.onExpire === 'auto_approve'`.
   */
  constructor(
    store: PendingActionStore,
    notifier: ApprovalNotifier,
    eventBus: EventBus,
    policy: ExpirationPolicy,
    toolExecutor?: ToolExecutor,
  ) {
    this.#store = store;
    this.#notifier = notifier;
    this.#bus = eventBus;
    this.#policy = policy;
    this.#toolExecutor = toolExecutor;
  }

  /**
   * Processes all actions that have passed their `expiresAt` deadline.
   *
   * @param _triggers - Trigger list (reserved for future use; currently unused).
   * @returns The number of actions processed (expired, auto-rejected, or auto-approved).
   */
  async process(_triggers?: ApprovalTrigger[]): Promise<number> {
    const expired = await this.#store.getExpired();
    let count = 0;

    for (const action of expired) {
      switch (this.#policy.onExpire) {
        case 'auto_reject': {
          const rejected = {
            ...action,
            status: 'rejected' as const,
            updatedAt: new Date(),
            resolution: {
              resolvedBy: 'system',
              resolvedAt: new Date(),
              decision: 'reject' as const,
              comment: 'Automatically rejected due to timeout.',
            },
          };
          await this.#store.update(rejected);
          if (this.#policy.notifyRequestor || this.#policy.notifyApprovers) {
            await this.#notifier.notifyExpiration(rejected);
          }
          this.#bus.emit('approval.expired', {
            actionId: action.id,
            expirationAction: 'auto_reject',
          });
          count++;
          break;
        }

        case 'auto_approve': {
          // Safety guard: skip auto-approve for high/critical risk actions
          if (action.risk !== 'low') {
            // Fall back to expire behaviour for non-low risk
            await this.#markExpired(action);
            count++;
            break;
          }
          // Execute the tool
          const toolInput = action.toolInput;
          let toolResult: import('../types/index.js').ToolResult | undefined;
          if (this.#toolExecutor !== undefined) {
            try {
              toolResult = await this.#toolExecutor.execute(
                action.toolName,
                toolInput,
                action.savedContext.executionContext,
              );
            } catch {
              // Execution failure → mark failed
              const failed = {
                ...action,
                status: 'failed' as const,
                updatedAt: new Date(),
              };
              await this.#store.update(failed);
              this.#bus.emit('approval.execution_failed', {
                actionId: action.id,
                toolName: action.toolName,
                error: 'Auto-approve execution failed',
              });
              count++;
              break;
            }
          }
          const approved = {
            ...action,
            status: 'completed' as const,
            updatedAt: new Date(),
            resolution: {
              resolvedBy: 'system',
              resolvedAt: new Date(),
              decision: 'approve' as const,
              comment: 'Automatically approved due to timeout policy.',
              ...(toolResult !== undefined && { toolResult }),
            },
          };
          await this.#store.update(approved);
          if (this.#policy.notifyRequestor || this.#policy.notifyApprovers) {
            await this.#notifier.notifyExpiration(approved);
          }
          this.#bus.emit('approval.expired', {
            actionId: action.id,
            expirationAction: 'auto_approve',
          });
          if (toolResult !== undefined) {
            this.#bus.emit('approval.executed', {
              actionId: action.id,
              toolName: action.toolName,
              toolResult,
            });
          }
          count++;
          break;
        }

        default: // 'expire'
          await this.#markExpired(action);
          count++;
          break;
      }
    }

    return count;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async #markExpired(
    action: Awaited<ReturnType<PendingActionStore['getExpired']>>[number],
  ): Promise<void> {
    const expiredAction = { ...action, status: 'expired' as const, updatedAt: new Date() };
    await this.#store.update(expiredAction);
    if (this.#policy.notifyRequestor || this.#policy.notifyApprovers) {
      await this.#notifier.notifyExpiration(expiredAction);
    }
    this.#bus.emit('approval.expired', {
      actionId: action.id,
      expirationAction: 'expire',
    });
  }
}
