import { randomUUID } from 'node:crypto';
import type {
  PendingAction,
  PendingActionFilter,
  ActionResolution,
  ApprovalTrigger,
  ApprovalRequirement,
  ApprovalCallback,
  EscalationResult,
  ExpirationPolicy,
  ExecutionContext,
  LLMMessage,
} from '../types/index.js';
import { EventBus } from '../events/EventBus.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';
import type { PendingActionStore } from './store/PendingActionStore.js';
import { ApprovalNotifier } from './notification/ApprovalNotifier.js';
import { TriggerEvaluator } from './TriggerEvaluator.js';
import { EscalationManager } from './EscalationManager.js';
import { ExpirationManager } from './ExpirationManager.js';
import { AccessDeniedError } from '../errors/index.js';
import { DEFAULT_APPROVAL_MESSAGES } from './messages.js';
import type { ApprovalMessages } from './messages.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration object for {@link ApprovalService}. */
export interface ApprovalConfig {
  /** Default timeout in minutes applied when a trigger has no explicit `timeoutMinutes`. Default: 60. */
  defaultTimeoutMinutes?: number;
  /** Expiration policy. Defaults to `{ onExpire: 'expire', notifyRequestor: true, notifyApprovers: true, checkIntervalMs: 60000 }`. */
  expiration?: Partial<ExpirationPolicy>;
  /**
   * When `true` (default), {@link ApprovalService.approve} and
   * {@link ApprovalService.reject} require the approver to belong to the
   * action's tenant and to hold one of its `approverRoles` (or be listed in
   * `approverUsers`). `'*'` in `approverRoles` admits any role.
   *
   * Set to `false` only if your application performs this authorization
   * itself before calling the service.
   */
  authorizeApprovers?: boolean;
  /** Overrides for the texts the SDK produces during approval flows (e.g. to localize them). */
  messages?: Partial<ApprovalMessages>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central service for the Human-in-the-Loop (HITL) subsystem.
 *
 * ### Responsibilities
 * - **Trigger management** — add, remove, and query triggers that gate tool calls.
 * - **Approval evaluation** — `requiresApproval()` is called by the Agent Loop
 *   before every tool execution.
 * - **Action lifecycle** — create, approve, reject, cancel pending actions.
 * - **Escalation** — delegate to {@link EscalationManager} for time-based escalation.
 * - **Expiration** — delegate to {@link ExpirationManager} for deadline handling.
 * - **Notifications** — delegate to {@link ApprovalNotifier} for channel delivery.
 * - **EventBus events** — emit lifecycle events for observability and audit capture.
 *
 * ### Non-blocking design
 * `createPendingAction()` stores the action and notifies approvers, then returns
 * immediately. The Agent Loop receives a partial response indicating the pending
 * state and continues without blocking. Resolution arrives asynchronously via
 * `approve()` or `reject()`.
 *
 * @example
 * ```typescript
 * const svc = new ApprovalService(store, notifier, toolExecutor, eventBus, {});
 * svc.addTrigger(largeTxTrigger);
 *
 * // In Agent Loop:
 * const req = svc.requiresApproval('finance.transfer', { amount: 15000 }, ctx);
 * if (req) {
 *   const action = await svc.createPendingAction('finance.transfer', input, ctx, trigger);
 *   // Return partial response — loop does not block
 * }
 * ```
 */
export class ApprovalService {
  readonly #store: PendingActionStore;
  readonly #notifier: ApprovalNotifier;
  readonly #toolExecutor: ToolExecutor;
  readonly #bus: EventBus;
  readonly #config: ApprovalConfig;
  readonly #triggers: ApprovalTrigger[] = [];
  readonly #evaluator: TriggerEvaluator;
  readonly #escalationMgr: EscalationManager;
  readonly #expirationMgr: ExpirationManager;
  readonly #messages: Readonly<ApprovalMessages>;

  /**
   * @param store        - Pending action persistence adapter.
   * @param notifier     - Notification coordinator.
   * @param toolExecutor - Used to execute tools post-approval.
   * @param eventBus     - Shared event bus for lifecycle events.
   * @param config       - Service configuration.
   */
  constructor(
    store: PendingActionStore,
    notifier: ApprovalNotifier,
    toolExecutor: ToolExecutor,
    eventBus: EventBus,
    config: ApprovalConfig,
  ) {
    this.#store = store;
    this.#notifier = notifier;
    this.#toolExecutor = toolExecutor;
    this.#bus = eventBus;
    this.#config = config;
    this.#evaluator = new TriggerEvaluator();
    this.#messages = Object.freeze({ ...DEFAULT_APPROVAL_MESSAGES, ...config.messages });

    const policy: ExpirationPolicy = {
      onExpire: config.expiration?.onExpire ?? 'expire',
      notifyRequestor: config.expiration?.notifyRequestor ?? true,
      notifyApprovers: config.expiration?.notifyApprovers ?? true,
      checkIntervalMs: config.expiration?.checkIntervalMs ?? 60_000,
    };
    this.#escalationMgr = new EscalationManager(store, notifier, eventBus);
    this.#expirationMgr = new ExpirationManager(store, notifier, eventBus, policy, toolExecutor);
  }

  /** Whether approve/reject authorize the approver (see {@link ApprovalConfig.authorizeApprovers}). */
  get authorizesApprovers(): boolean {
    return this.#config.authorizeApprovers !== false;
  }

  /** Resolved texts for approval flows: the defaults merged with `config.messages`. */
  get messages(): Readonly<ApprovalMessages> {
    return this.#messages;
  }

  // ─── Trigger management ─────────────────────────────────────────────────────

  /**
   * Registers a new approval trigger.
   *
   * @param trigger - Trigger configuration. Duplicate IDs are silently replaced.
   */
  addTrigger(trigger: ApprovalTrigger): void {
    const existing = this.#triggers.findIndex((t) => t.id === trigger.id);
    if (existing >= 0) {
      this.#triggers[existing] = trigger;
    } else {
      this.#triggers.push(trigger);
    }
  }

  /**
   * Removes a trigger by ID.
   *
   * @param triggerId - ID of the trigger to remove.
   * @returns `true` if found and removed; `false` if not found.
   */
  removeTrigger(triggerId: string): boolean {
    const idx = this.#triggers.findIndex((t) => t.id === triggerId);
    if (idx < 0) return false;
    this.#triggers.splice(idx, 1);
    return true;
  }

  /**
   * Returns a snapshot of all registered triggers.
   */
  getTriggers(): ApprovalTrigger[] {
    return [...this.#triggers];
  }

  /**
   * Returns the trigger with the given ID, or `undefined` if not found.
   *
   * Used by the Agent Loop to retrieve the full trigger after
   * `requiresApproval()` returns a matching {@link ApprovalRequirement}.
   *
   * @param id - The trigger ID.
   */
  getTriggerById(id: string): ApprovalTrigger | undefined {
    return this.#triggers.find((t) => t.id === id);
  }

  // ─── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Synchronously evaluates whether a tool call requires human approval.
   *
   * Called by the Agent Loop before every tool execution. Returns `null` when
   * no trigger matches (tool can execute normally).
   *
   * @param toolName - Name of the tool to evaluate.
   * @param input    - Tool input object.
   * @param context  - Execution context of the current request.
   * @returns Approval requirement details, or `null` if no approval needed.
   */
  requiresApproval(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
  ): ApprovalRequirement | null {
    return this.#evaluator.evaluate(this.#triggers, toolName, input, context);
  }

  // ─── Lifecycle: create ──────────────────────────────────────────────────────

  /**
   * Creates a pending action and notifies approvers.
   *
   * @param toolName      - Tool that requires approval.
   * @param input         - Validated tool input.
   * @param context       - Execution context of the originating request.
   * @param trigger       - The trigger that fired (drives timeout and approver config).
   * @param _callback     - Optional callback for delivering resolution notifications
   *   (reserved for future webhook/queue integration; currently no-op).
   * @param resumeContext - Suspend/resume checkpoint data set by the `AgentLoop`.
   *   When present, `Orchestrator.approve()` will resume the agent loop after
   *   executing the tool, rather than returning the result in isolation.
   * @returns The newly created {@link PendingAction}.
   */
  async createPendingAction(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
    trigger: ApprovalTrigger,
    _callback?: ApprovalCallback,
    resumeContext?: {
      messagesSnapshot: LLMMessage[];
      toolCallId: string;
      siblingCalls: Array<{ id: string; toolName: string }>;
    },
  ): Promise<PendingAction> {
    const now = new Date();
    const timeoutMs =
      (trigger.approvalConfig.timeoutMinutes ?? this.#config.defaultTimeoutMinutes ?? 60) *
      60 *
      1000;

    const action: PendingAction = {
      id: randomUUID(),
      requestId: context.requestId ?? randomUUID(),
      sessionId: context.sessionId ?? '',
      tenantId: context.tenantId,
      requestedBy: context.userId,
      agentId: context.agentId ?? '',
      toolName,
      toolInput: input,
      description: `Approval required for tool: ${toolName}`,
      reason: trigger.description,
      risk: trigger.approvalConfig.risk,
      approverRoles: [...trigger.approvalConfig.approverRoles],
      ...(trigger.approvalConfig.approverUsers !== undefined
        ? { approverUsers: [...trigger.approvalConfig.approverUsers] }
        : {}),
      currentEscalationLevel: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + timeoutMs),
      savedContext: {
        executionContext: context,
        agentConfig: context.agentId ?? '',
        ...(resumeContext !== undefined && {
          messagesSnapshot: resumeContext.messagesSnapshot,
          toolCallId: resumeContext.toolCallId,
          siblingCalls: resumeContext.siblingCalls,
        }),
      },
      metadata: { triggerId: trigger.id },
    };

    await this.#store.create(action);
    await this.#notifier.notifyApprovers(action);

    this.#bus.emit('approval.required', {
      actionId: action.id,
      toolName: action.toolName,
      risk: action.risk,
      approverRoles: action.approverRoles,
    });

    return action;
  }

  // ─── Lifecycle: approve ─────────────────────────────────────────────────────

  /**
   * Phase 1 of the two-phase approve flow: claims the action, executes the
   * tool, and persists the resolution.
   *
   * - Uses {@link PendingActionStore.claimForExecution} as an atomic idempotency
   *   fence — only the first concurrent caller succeeds; subsequent callers
   *   receive an error.
   * - After a successful tool execution, the status is set to `tool_completed`
   *   when a resume checkpoint exists, or `completed` for legacy fire-and-approve
   *   actions.
   * - Phase 2 (AgentLoop resume) is handled by the caller
   *   (`Orchestrator.approve()`), which then calls {@link markResuming},
   *   {@link markResumeCompleted}, or {@link markResumeFailed}.
   *
   * @param actionId        - UUID of the action to approve.
   * @param approverContext - Execution context of the approver.
   * @param options         - Optional comment, conditions, and modified input.
   * @returns The completed {@link ActionResolution} (with tool result).
   * @throws `Error` if the action does not exist or is already being processed.
   * @throws {@link AccessDeniedError} if the approver is not authorized
   *   (see {@link ApprovalConfig.authorizeApprovers}).
   */
  async approve(
    actionId: string,
    approverContext: ExecutionContext,
    options?: { comment?: string; conditions?: string; modifiedInput?: any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<ActionResolution> {
    if (this.#config.authorizeApprovers !== false) {
      // A missing action falls through to the claim below, which reports it.
      const existing = await this.#store.getById(actionId);
      if (existing !== null) this.#authorizeApprover(existing, approverContext, 'approve');
    }

    const claimInfo: { userId: string; comment?: string; modifiedInput?: any } = {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      userId: approverContext.userId,
      ...(options?.comment !== undefined && { comment: options.comment }),
      ...(options?.modifiedInput !== undefined && { modifiedInput: options.modifiedInput }),
    };
    const claimed = await this.#store.claimForExecution(actionId, claimInfo);
    if (claimed === null) {
      throw new Error(
        `Action ${actionId} cannot be approved: it does not exist or is already being processed`,
      );
    }

    const toolInput = options?.modifiedInput ?? claimed.toolInput;

    // Execute the tool
    let toolResult: import('../types/index.js').ToolResult | undefined;
    try {
      toolResult = await this.#toolExecutor.execute(
        claimed.toolName,
        toolInput,
        claimed.savedContext.executionContext,
      );
    } catch (err) {
      const failed: PendingAction = { ...claimed, status: 'failed', updatedAt: new Date() };
      await this.#store.update(failed);
      this.#bus.emit('approval.execution_failed', {
        actionId: claimed.id,
        toolName: claimed.toolName,
        error: String(err),
      });
      throw err;
    }

    const resolution: ActionResolution = {
      resolvedBy: approverContext.userId,
      resolvedAt: new Date(),
      decision: 'approve',
      ...(options?.comment !== undefined ? { comment: options.comment } : {}),
      ...(options?.conditions !== undefined ? { conditions: options.conditions } : {}),
      ...(options?.modifiedInput !== undefined ? { modifiedInput: options.modifiedInput } : {}),
      toolResult,
    };

    // tool_completed when a resume checkpoint exists; completed for legacy path.
    const hasCheckpoint = claimed.savedContext.messagesSnapshot !== undefined;
    const nextStatus = hasCheckpoint ? 'tool_completed' : 'completed';

    const resolved: PendingAction = {
      ...claimed,
      status: nextStatus,
      updatedAt: new Date(),
      resolution,
    };
    await this.#store.update(resolved);

    await this.#notifier.notifyResolution(resolved, resolution);
    this.#bus.emit('approval.approved', {
      actionId: claimed.id,
      resolvedBy: approverContext.userId,
      comment: options?.comment,
    });
    this.#bus.emit('approval.executed', {
      actionId: claimed.id,
      toolName: claimed.toolName,
      toolResult,
    });

    return resolution;
  }

  // ─── Lifecycle: resume markers ───────────────────────────────────────────────

  /**
   * Marks an action as having entered the AgentLoop resume phase.
   *
   * Valid prior statuses: `tool_completed`, `resume_failed`.
   *
   * @param actionId - UUID of the action.
   * @throws `Error` if the action is not found or is not in a retryable state.
   */
  async markResuming(actionId: string): Promise<void> {
    const action = await this.#requireAction(actionId);
    if (action.status !== 'tool_completed' && action.status !== 'resume_failed') {
      throw new Error(`Cannot mark action ${actionId} as resuming: status is '${action.status}'`);
    }
    await this.#store.update({ ...action, status: 'resuming', updatedAt: new Date() });
  }

  /**
   * Marks an action as fully completed after a successful AgentLoop resume.
   *
   * Valid prior status: `resuming`.
   *
   * @param actionId - UUID of the action.
   * @throws `Error` if the action is not found or not in `resuming` state.
   */
  async markResumeCompleted(actionId: string): Promise<void> {
    const action = await this.#requireAction(actionId);
    if (action.status !== 'resuming') {
      throw new Error(`Cannot mark action ${actionId} as completed: status is '${action.status}'`);
    }
    await this.#store.update({ ...action, status: 'completed', updatedAt: new Date() });
    this.#bus.emit('approval.resume_completed', { actionId });
  }

  /**
   * Marks an action as having failed during the AgentLoop resume phase.
   *
   * The tool already ran successfully (`tool_completed` → `resuming`); only the
   * resume threw. The action can be retried via `Orchestrator.retryResume()`.
   *
   * Valid prior status: `resuming`.
   *
   * @param actionId - UUID of the action.
   * @param error    - The error that caused the resume to fail.
   * @throws `Error` if the action is not found or not in `resuming` state.
   */
  async markResumeFailed(actionId: string, error: unknown): Promise<void> {
    const action = await this.#requireAction(actionId);
    if (action.status !== 'resuming') {
      throw new Error(
        `Cannot mark action ${actionId} as resume_failed: status is '${action.status}'`,
      );
    }
    await this.#store.update({ ...action, status: 'resume_failed', updatedAt: new Date() });
    this.#bus.emit('approval.resume_failed', {
      actionId,
      toolName: action.toolName,
      error: String(error),
    });
  }

  // ─── Lifecycle: reject ──────────────────────────────────────────────────────

  /**
   * Rejects a pending action.
   *
   * @param actionId        - UUID of the action to reject.
   * @param approverContext - Execution context of the approver.
   * @param options         - Optional comment and reason.
   * @returns The completed {@link ActionResolution}.
   * @throws `Error` if the action is not found or is not in an approvable state.
   * @throws {@link AccessDeniedError} if the approver is not authorized
   *   (see {@link ApprovalConfig.authorizeApprovers}).
   */
  async reject(
    actionId: string,
    approverContext: ExecutionContext,
    options?: { comment?: string; reason?: string },
  ): Promise<ActionResolution> {
    const action = await this.#requireAction(actionId);
    if (this.#config.authorizeApprovers !== false) {
      this.#authorizeApprover(action, approverContext, 'reject');
    }
    this.#requireApprovableStatus(action);

    const resolution: ActionResolution = {
      resolvedBy: approverContext.userId,
      resolvedAt: new Date(),
      decision: 'reject',
      ...(options?.comment !== undefined
        ? { comment: options.comment }
        : options?.reason !== undefined
          ? { comment: options.reason }
          : {}),
    };

    const rejected: PendingAction = {
      ...action,
      status: 'rejected',
      updatedAt: new Date(),
      resolution,
    };
    await this.#store.update(rejected);

    await this.#notifier.notifyResolution(rejected, resolution);
    this.#bus.emit('approval.rejected', {
      actionId: action.id,
      resolvedBy: approverContext.userId,
      reason: options?.comment ?? options?.reason,
    });

    return resolution;
  }

  // ─── Lifecycle: cancel ──────────────────────────────────────────────────────

  /**
   * Cancels a pending action initiated by the same user.
   *
   * @param actionId - UUID of the action to cancel.
   * @param context  - Execution context of the original requestor.
   * @throws `Error` if action not found or already resolved.
   */
  async cancel(actionId: string, context: ExecutionContext): Promise<void> {
    const action = await this.#requireAction(actionId);
    this.#requireApprovableStatus(action);

    const cancelled: PendingAction = {
      ...action,
      status: 'cancelled',
      updatedAt: new Date(),
    };
    await this.#store.update(cancelled);

    this.#bus.emit('approval.cancelled', {
      actionId: action.id,
      cancelledBy: context.userId,
    });
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  /**
   * Returns pending actions matching the given filter.
   *
   * @param filter - Filter criteria.
   */
  async getPending(filter: PendingActionFilter): Promise<PendingAction[]> {
    return this.#store.getPending(filter);
  }

  /**
   * Returns a single pending action by UUID, or `null` if not found.
   *
   * @param actionId - Action UUID.
   */
  async getById(actionId: string): Promise<PendingAction | null> {
    return this.#store.getById(actionId);
  }

  /**
   * Returns all pending actions that originated from the same request.
   *
   * @param requestId - Request UUID.
   */
  async getByRequestId(requestId: string): Promise<PendingAction[]> {
    return this.#store.getPending({ requestId });
  }

  // ─── Batch processing ───────────────────────────────────────────────────────

  /**
   * Processes escalations for all pending/escalated actions.
   *
   * Delegates to {@link EscalationManager.process}.
   *
   * @returns Summary of escalated and expired action counts.
   */
  async processEscalations(): Promise<EscalationResult> {
    return this.#escalationMgr.process(this.#triggers);
  }

  /**
   * Processes expirations for all actions past their deadline.
   *
   * Delegates to {@link ExpirationManager.process}.
   *
   * @returns The number of expired actions processed.
   */
  async processExpirations(): Promise<number> {
    return this.#expirationMgr.process(this.#triggers);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async #requireAction(id: string): Promise<PendingAction> {
    const action = await this.#store.getById(id);
    if (action === null) throw new Error(`PendingAction not found: ${id}`);
    return action;
  }

  /**
   * Checks that the approver belongs to the action's tenant and holds one of
   * its approver roles (or is listed as an approver user).
   *
   * @throws {@link AccessDeniedError} when the approver is not authorized.
   */
  #authorizeApprover(
    action: PendingAction,
    approver: ExecutionContext,
    decision: 'approve' | 'reject',
  ): void {
    const approverRoles = action.approverRoles ?? [];
    const sameTenant = approver.tenantId === action.tenantId;
    const byRole =
      approverRoles.includes('*') ||
      (approver.roles ?? []).some((role) => approverRoles.includes(role));
    const byUser = action.approverUsers?.includes(approver.userId) ?? false;
    if (sameTenant && (byRole || byUser)) return;

    this.#bus.emit('security.approval.denied', {
      actionId: action.id,
      toolName: action.toolName,
      decision,
      reason: sameTenant
        ? `approver holds none of the roles [${approverRoles.join(', ')}]`
        : 'approver belongs to a different tenant',
      _context: {
        tenantId: approver.tenantId,
        userId: approver.userId,
        agentId: approver.agentId,
        sessionId: approver.sessionId,
        requestId: approver.requestId,
      },
    });
    throw new AccessDeniedError('approval', action.id, approver.roles ?? []);
  }

  #requireApprovableStatus(action: PendingAction): void {
    const approvable: PendingAction['status'][] = ['pending', 'escalated'];
    if (!approvable.includes(action.status)) {
      throw new Error(
        `Action ${action.id} cannot be approved/rejected/cancelled: status is '${action.status}'`,
      );
    }
  }
}
