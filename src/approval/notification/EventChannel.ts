import type { Notification } from '../../types/index.js';
import { EventBus } from '../../events/EventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// NotificationChannel (abstract base)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for notification delivery channels.
 *
 * Each channel implementation handles a specific transport (webhook, email,
 * EventBus, etc.). Channels are passed to {@link ApprovalNotifier} and are
 * called for every notification regardless of the pending action's escalation
 * level.
 */
export abstract class NotificationChannel {
  /** Human-readable name identifying this channel (e.g. `'webhook'`, `'event'`). */
  abstract readonly name: string;

  /**
   * Delivers a notification via this channel.
   *
   * @param notification - The notification payload to deliver.
   * @returns `true` if delivery succeeded; `false` if it failed.
   */
  abstract send(notification: Notification): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EventChannel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification channel that delivers notifications by emitting events on the
 * shared {@link EventBus}.
 *
 * This channel is always present in production deployments because the EventBus
 * is the SDK's primary inter-module communication mechanism. The {@link AuditLogger}
 * and any custom EventBus subscribers receive approval events without requiring
 * external connectivity.
 *
 * ### Events emitted
 * | Notification type   | EventBus event name              |
 * |---------------------|----------------------------------|
 * | approval_required   | `approval.required`              |
 * | action_resolved     | `approval.resolved`              |
 * | escalation          | `approval.escalated`             |
 * | action_expired      | `approval.expired`               |
 */
export class EventChannel extends NotificationChannel {
  readonly name = 'event';

  readonly #bus: EventBus;

  /**
   * @param eventBus - The shared EventBus instance to emit notifications onto.
   */
  constructor(eventBus: EventBus) {
    super();
    this.#bus = eventBus;
  }

  /**
   * Emits the notification as an EventBus event.
   *
   * Always returns `true` since EventBus emission is synchronous and in-process.
   *
   * @param notification - The notification to emit.
   * @returns `true` (always succeeds for in-process delivery).
   */
  async send(notification: Notification): Promise<boolean> {
    const eventName = this.#mapEventName(notification.type);
    this.#bus.emit(eventName, {
      actionId: notification.action.id,
      toolName: notification.action.toolName,
      tenantId: notification.action.tenantId,
      requestedBy: notification.action.requestedBy,
      risk: notification.action.risk,
      approverRoles: notification.action.approverRoles,
      resolution: notification.resolution,
      escalationLevel: notification.escalationLevel,
      recipientRoles: notification.recipientRoles,
      recipientUsers: notification.recipientUsers,
    });
    return true;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  #mapEventName(type: Notification['type']): string {
    switch (type) {
      case 'approval_required':
        return 'approval.required';
      case 'action_resolved':
        return 'approval.resolved';
      case 'escalation':
        return 'approval.escalated';
      case 'action_expired':
        return 'approval.expired';
    }
  }
}
