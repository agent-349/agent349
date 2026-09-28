import type { ApprovalTrigger, EscalationResult } from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import type { PendingActionStore } from './store/PendingActionStore.js';
import type { ApprovalNotifier } from './notification/ApprovalNotifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// EscalationManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles the automatic escalation of unresolved pending actions.
 *
 * When a pending action is not resolved within the time configured for its
 * current escalation level, this manager promotes it to the next level:
 * - Updates `currentEscalationLevel`, `approverRoles`, and `status` on the
 *   action record.
 * - Notifies the new approvers via the {@link ApprovalNotifier}.
 * - Emits `approval.escalated` on the {@link EventBus}.
 *
 * If there is no higher level and the action has also passed its `expiresAt`
 * deadline, the action is marked `expired` and `approval.expired` is emitted.
 *
 * ### Scheduling
 * The host application is responsible for calling {@link process} periodically
 * (e.g. via `setInterval` with `escalationCheckIntervalMs`). The SDK does not
 * self-schedule to avoid hidden background work in serverless environments.
 *
 * @example
 * ```typescript
 * const mgr = new EscalationManager(store, notifier, bus);
 * setInterval(() => mgr.process(triggers), 60_000);
 * ```
 */
export class EscalationManager {
  readonly #store: PendingActionStore;
  readonly #notifier: ApprovalNotifier;
  readonly #bus: EventBus;

  /**
   * @param store    - Pending action store for reading and updating records.
   * @param notifier - Notifier for alerting new approvers after escalation.
   * @param eventBus - Event bus for broadcasting escalation/expiry events.
   */
  constructor(store: PendingActionStore, notifier: ApprovalNotifier, eventBus: EventBus) {
    this.#store = store;
    this.#notifier = notifier;
    this.#bus = eventBus;
  }

  /**
   * Processes all pending and escalated actions that are overdue for their
   * current escalation level.
   *
   * @param triggers - Full list of configured triggers (used to look up
   *   escalation configs per action).
   * @returns Summary of how many actions were escalated and how many expired.
   */
  async process(triggers: ApprovalTrigger[]): Promise<EscalationResult> {
    const pending = await this.#store.getPending({ status: ['pending', 'escalated'] });
    const result: EscalationResult = { escalated: 0, expired: 0 };
    const now = Date.now();

    for (const action of pending) {
      // Find the trigger that created this action (matched by approverRoles heuristic
      // is too fragile; we store triggerId in metadata if available, else scan by toolName).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const triggerId = (action.metadata as Record<string, any> | undefined)?.triggerId as
        | string
        | undefined;
      const trigger =
        triggerId !== undefined
          ? triggers.find((t) => t.id === triggerId)
          : triggers.find(
              (t) =>
                t.approvalConfig.escalation !== undefined &&
                (t.scope.tools?.includes(action.toolName) ?? t.scope.all === true),
            );

      const escalation = trigger?.approvalConfig.escalation;
      if (escalation === undefined) {
        // No escalation config — check if action has globally expired
        if (now > action.expiresAt.getTime()) {
          await this.#expireAction(action);
          result.expired++;
        }
        continue;
      }

      const currentLevel = action.currentEscalationLevel;
      const nextLevel = escalation.levels.find((l) => l.level === currentLevel + 1);

      if (nextLevel === undefined) {
        // No further level — expire if past expiresAt
        if (now > action.expiresAt.getTime()) {
          await this.#expireAction(action);
          result.expired++;
        }
        continue;
      }

      // Has the current level's timeout elapsed?
      const levelTimeout = nextLevel.afterMinutes * 60 * 1000;
      const levelStart = action.updatedAt.getTime();
      if (now - levelStart > levelTimeout) {
        // Escalate to next level
        const updated = {
          ...action,
          currentEscalationLevel: nextLevel.level,
          approverRoles: nextLevel.approverRoles,
          ...(nextLevel.approverUsers !== undefined
            ? { approverUsers: nextLevel.approverUsers }
            : {}),
          status: 'escalated' as const,
          updatedAt: new Date(),
        };
        await this.#store.update(updated);
        await this.#notifier.notifyEscalation(updated, nextLevel);
        this.#bus.emit('approval.escalated', {
          actionId: action.id,
          fromLevel: currentLevel,
          toLevel: nextLevel.level,
          newApprovers: nextLevel.approverRoles,
        });
        result.escalated++;
      }
    }

    return result;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async #expireAction(action: Parameters<PendingActionStore['update']>[0]): Promise<void> {
    const expired = { ...action, status: 'expired' as const, updatedAt: new Date() };
    await this.#store.update(expired);
    await this.#notifier.notifyExpiration(expired);
    this.#bus.emit('approval.expired', {
      actionId: action.id,
      expirationAction: 'expire',
    });
  }
}
