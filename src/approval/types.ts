/**
 * Approval (HITL) module types — pending actions, triggers, escalation,
 * notifications, and approval callbacks.
 *
 * All types are canonically defined in `src/types/index.ts` (the shared type
 * layer) and re-exported here so that intra-module imports stay local
 * (`./types.js`) without duplicating definitions or inverting the dependency
 * direction (approval → types, never types → approval).
 */
export type {
  PendingActionStatus,
  PendingAction,
  ActionResolution,
  ApprovalTrigger,
  ApprovalCondition,
  EscalationConfig,
  EscalationLevel,
  ApprovalCallback,
  ApprovalRequirement,
  PendingActionFilter,
  Notification,
  NotificationResult,
} from '../types/index.js';
