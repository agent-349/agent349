import type {
  PendingAction,
  ActionResolution,
  EscalationLevel,
  Notification,
  NotificationResult,
} from '../../types/index.js';
import type { NotificationChannel } from './EventChannel.js';

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalNotifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coordinates notification delivery across one or more {@link NotificationChannel}
 * implementations.
 *
 * The notifier tries all registered channels for every notification and reports
 * which succeeded and which failed. Failures in one channel do not prevent
 * delivery via other channels.
 *
 * ### Usage
 * ```typescript
 * const notifier = new ApprovalNotifier([
 *   new EventChannel(eventBus),   // always present
 *   new WebhookChannel(webhookUrl), // optional
 * ]);
 *
 * await notifier.notifyApprovers(pendingAction);
 * ```
 */
export class ApprovalNotifier {
  readonly #channels: NotificationChannel[];

  /**
   * @param channels - Ordered list of channels to deliver notifications through.
   *   At least one channel should be provided; an empty list means notifications
   *   are silently dropped.
   */
  constructor(channels: NotificationChannel[]) {
    this.#channels = [...channels];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Notifies approvers that a new action is awaiting their decision.
   *
   * @param action - The newly created pending action.
   * @returns Delivery result summarising which channels succeeded and failed.
   */
  async notifyApprovers(action: PendingAction): Promise<NotificationResult> {
    return this.#deliver({
      type: 'approval_required',
      action,
      recipientRoles: action.approverRoles,
      ...(action.approverUsers !== undefined && { recipientUsers: action.approverUsers }),
    });
  }

  /**
   * Notifies the originating system (and optionally the requestor) that an
   * action has been approved or rejected.
   *
   * @param action     - The resolved pending action.
   * @param resolution - The approval/rejection decision.
   * @returns Delivery result.
   */
  async notifyResolution(
    action: PendingAction,
    resolution: ActionResolution,
  ): Promise<NotificationResult> {
    return this.#deliver({
      type: 'action_resolved',
      action,
      resolution,
    });
  }

  /**
   * Notifies the new set of approvers that an action has been escalated to them.
   *
   * @param action    - The escalated pending action (already updated in store).
   * @param newLevel  - The escalation level that was just activated.
   * @returns Delivery result.
   */
  async notifyEscalation(
    action: PendingAction,
    newLevel: EscalationLevel,
  ): Promise<NotificationResult> {
    return this.#deliver({
      type: 'escalation',
      action,
      escalationLevel: newLevel.level,
      recipientRoles: newLevel.approverRoles,
      ...(newLevel.approverUsers !== undefined && { recipientUsers: newLevel.approverUsers }),
    });
  }

  /**
   * Notifies relevant parties that an action has expired without resolution.
   *
   * @param action - The expired pending action.
   * @returns Delivery result.
   */
  async notifyExpiration(action: PendingAction): Promise<NotificationResult> {
    return this.#deliver({
      type: 'action_expired',
      action,
      recipientRoles: action.approverRoles,
      ...(action.approverUsers !== undefined && { recipientUsers: action.approverUsers }),
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async #deliver(notification: Notification): Promise<NotificationResult> {
    const channelsSent: string[] = [];
    const channelsFailed: string[] = [];
    const errors: string[] = [];

    for (const channel of this.#channels) {
      try {
        const ok = await channel.send(notification);
        if (ok) {
          channelsSent.push(channel.name);
        } else {
          channelsFailed.push(channel.name);
        }
      } catch (err) {
        channelsFailed.push(channel.name);
        errors.push(`${channel.name}: ${String(err)}`);
      }
    }

    const result: NotificationResult = { channelsSent, channelsFailed };
    if (errors.length > 0) result.errors = errors;
    return result;
  }
}
