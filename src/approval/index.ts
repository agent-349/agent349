// Approval module: Service, Triggers, Escalation, Notify
export type * from './types.js';
export { ApprovalService } from './ApprovalService.js';
export type { ApprovalConfig } from './ApprovalService.js';
export { DEFAULT_APPROVAL_MESSAGES, formatApprovalMessage } from './messages.js';
export type { ApprovalMessages } from './messages.js';
export { TriggerEvaluator } from './TriggerEvaluator.js';
export { EscalationManager } from './EscalationManager.js';
export { ExpirationManager } from './ExpirationManager.js';
export { PendingActionStore } from './store/PendingActionStore.js';
export { InMemoryPendingStore } from './store/InMemoryPendingStore.js';
export { MongoPendingActionStore } from './store/MongoPendingActionStore.js';
export type { MongoPendingActionStoreConfig } from './store/MongoPendingActionStore.js';
export { ApprovalNotifier } from './notification/ApprovalNotifier.js';
export { NotificationChannel, EventChannel } from './notification/EventChannel.js';
