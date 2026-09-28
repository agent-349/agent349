import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalService } from '../../../src/approval/ApprovalService.js';
import { InMemoryPendingStore } from '../../../src/approval/store/InMemoryPendingStore.js';
import { ApprovalNotifier } from '../../../src/approval/notification/ApprovalNotifier.js';
import { EventChannel } from '../../../src/approval/notification/EventChannel.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import type { ApprovalTrigger, ExecutionContext } from '../../../src/types/index.js';
import { AccessDeniedError } from '../../../src/errors/index.js';
import { DEFAULT_APPROVAL_MESSAGES } from '../../../src/approval/messages.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeToolExecutor(toolResult: any = { content: 'done', success: true }): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(toolResult),
  } as unknown as ToolExecutor;
}

function makeTrigger(overrides: Partial<ApprovalTrigger> = {}): ApprovalTrigger {
  return {
    id: 'trigger-1',
    name: 'Large Transfer',
    description: 'Amount exceeds limit',
    enabled: true,
    scope: { tools: ['finance.transfer'] },
    conditions: [{ type: 'always' }],
    approvalConfig: {
      risk: 'high',
      approverRoles: ['manager'],
      timeoutMinutes: 60,
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    roles: ['employee'],
    ...overrides,
  };
}

/** Context of an approver authorized by the default trigger (`approverRoles: ['manager']`). */
function approverContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return makeContext({ roles: ['manager'], ...overrides });
}

// ─── Test setup ───────────────────────────────────────────────────────────────

describe('ApprovalService', () => {
  let store: InMemoryPendingStore;
  let bus: EventBus;
  let notifier: ApprovalNotifier;
  let toolExecutor: ToolExecutor;
  let service: ApprovalService;

  beforeEach(() => {
    store = new InMemoryPendingStore();
    bus = new EventBus();
    notifier = new ApprovalNotifier([new EventChannel(bus)]);
    toolExecutor = makeToolExecutor();
    service = new ApprovalService(store, notifier, toolExecutor, bus, {});
  });

  // ─── Trigger management ───────────────────────────────────────────────────

  it('adds and retrieves triggers', () => {
    const t = makeTrigger();
    service.addTrigger(t);
    expect(service.getTriggers()).toHaveLength(1);
    expect(service.getTriggers()[0]!.id).toBe('trigger-1');
  });

  it('replaces trigger with same id', () => {
    service.addTrigger(makeTrigger({ name: 'Old Name' }));
    service.addTrigger(makeTrigger({ name: 'New Name' }));
    expect(service.getTriggers()).toHaveLength(1);
    expect(service.getTriggers()[0]!.name).toBe('New Name');
  });

  it('removes trigger by id', () => {
    service.addTrigger(makeTrigger());
    expect(service.removeTrigger('trigger-1')).toBe(true);
    expect(service.getTriggers()).toHaveLength(0);
  });

  it('returns false when removing non-existent trigger', () => {
    expect(service.removeTrigger('does-not-exist')).toBe(false);
  });

  // ─── requiresApproval ─────────────────────────────────────────────────────

  it('requiresApproval returns null when no triggers registered', () => {
    const result = service.requiresApproval('finance.transfer', {}, makeContext());
    expect(result).toBeNull();
  });

  it('requiresApproval returns requirement when trigger matches', () => {
    service.addTrigger(makeTrigger());
    const result = service.requiresApproval('finance.transfer', {}, makeContext());
    expect(result).not.toBeNull();
    expect(result!.risk).toBe('high');
    expect(result!.approverRoles).toEqual(['manager']);
  });

  it('requiresApproval returns null for non-matching tool', () => {
    service.addTrigger(makeTrigger());
    const result = service.requiresApproval('hr.getEmployee', {}, makeContext());
    expect(result).toBeNull();
  });

  // ─── createPendingAction ──────────────────────────────────────────────────

  it('creates a pending action and stores it', async () => {
    const trigger = makeTrigger();
    const ctx = makeContext();
    const action = await service.createPendingAction(
      'finance.transfer',
      { amount: 5000 },
      ctx,
      trigger,
    );

    expect(action.id).toBeTruthy();
    expect(action.toolName).toBe('finance.transfer');
    expect(action.toolInput).toEqual({ amount: 5000 });
    expect(action.status).toBe('pending');
    expect(action.risk).toBe('high');
    expect(action.approverRoles).toEqual(['manager']);
    expect(action.tenantId).toBe('tenant-1');
    expect(action.requestedBy).toBe('user-1');
    expect(action.metadata).toMatchObject({ triggerId: 'trigger-1' });

    const stored = await store.getById(action.id);
    expect(stored).not.toBeNull();
  });

  it('creates pending action with correct expiresAt from trigger timeout', async () => {
    const trigger = makeTrigger({
      approvalConfig: { risk: 'high', approverRoles: ['manager'], timeoutMinutes: 30 },
    });
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      trigger,
    );

    const expiresInMs = action.expiresAt.getTime() - action.createdAt.getTime();
    expect(expiresInMs).toBeGreaterThanOrEqual(30 * 60 * 1000 - 10);
    expect(expiresInMs).toBeLessThanOrEqual(30 * 60 * 1000 + 100);
  });

  it('emits approval.required event on createPendingAction', async () => {
    const events: any[] = [];
    bus.on('approval.required', (e) => events.push(e));

    await service.createPendingAction('finance.transfer', {}, makeContext(), makeTrigger());
    // EventChannel also emits approval.required, so there are ≥1 event(s)
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.data.toolName === 'finance.transfer');
    expect(ev).toBeDefined();
    expect(ev!.data.risk).toBe('high');
  });

  // ─── approve ─────────────────────────────────────────────────────────────

  it('approves an action, executes tool, marks completed', async () => {
    const trigger = makeTrigger();
    const action = await service.createPendingAction(
      'finance.transfer',
      { amount: 100 },
      makeContext(),
      trigger,
    );

    const approverCtx = approverContext({ userId: 'manager-1' });
    const resolution = await service.approve(action.id, approverCtx);

    expect(resolution.decision).toBe('approve');
    expect(resolution.resolvedBy).toBe('manager-1');
    expect(toolExecutor.execute).toHaveBeenCalledOnce();

    const updated = await store.getById(action.id);
    expect(updated!.status).toBe('completed');
    expect(updated!.resolution).toBeDefined();
  });

  it('emits approval.approved and approval.executed events', async () => {
    const approvedEvents: any[] = [];
    const executedEvents: any[] = [];
    bus.on('approval.approved', (e) => approvedEvents.push(e));
    bus.on('approval.executed', (e) => executedEvents.push(e));

    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await service.approve(action.id, approverContext({ userId: 'manager-1' }));

    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]!.data.resolvedBy).toBe('manager-1');
    expect(executedEvents).toHaveLength(1);
    expect(executedEvents[0]!.data.toolName).toBe('finance.transfer');
  });

  it('approve passes comment through to resolution', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    const resolution = await service.approve(action.id, approverContext(), {
      comment: 'Looks good',
    });
    expect(resolution.comment).toBe('Looks good');
  });

  it('approve uses modifiedInput when provided', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      { amount: 100 },
      makeContext(),
      makeTrigger(),
    );
    await service.approve(action.id, approverContext(), { modifiedInput: { amount: 50 } });
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'finance.transfer',
      { amount: 50 },
      expect.anything(),
    );
  });

  it('marks as failed and emits approval.execution_failed when tool throws', async () => {
    const failExec: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as ToolExecutor;
    const svc = new ApprovalService(store, notifier, failExec, bus, {});

    const failedEvents: any[] = [];
    bus.on('approval.execution_failed', (e) => failedEvents.push(e));

    const action = await svc.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await expect(svc.approve(action.id, approverContext())).rejects.toThrow('timeout');

    const updated = await store.getById(action.id);
    expect(updated!.status).toBe('failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('throws when approving a non-existent action', async () => {
    await expect(service.approve('no-such-id', approverContext())).rejects.toThrow(
      'cannot be approved',
    );
  });

  it('throws when approving an already-resolved action', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await service.approve(action.id, approverContext());
    await expect(service.approve(action.id, approverContext())).rejects.toThrow(
      /cannot be approved/,
    );
  });

  // ─── reject ───────────────────────────────────────────────────────────────

  it('rejects an action and marks it rejected', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    const resolution = await service.reject(action.id, approverContext({ userId: 'manager-2' }), {
      comment: 'Not authorized',
    });

    expect(resolution.decision).toBe('reject');
    expect(resolution.resolvedBy).toBe('manager-2');
    expect(resolution.comment).toBe('Not authorized');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    const updated = await store.getById(action.id);
    expect(updated!.status).toBe('rejected');
  });

  it('emits approval.rejected event', async () => {
    const rejectedEvents: any[] = [];
    bus.on('approval.rejected', (e) => rejectedEvents.push(e));

    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await service.reject(action.id, approverContext({ userId: 'manager-2' }), {
      reason: 'Policy violation',
    });

    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]!.data.resolvedBy).toBe('manager-2');
  });

  it('uses reason field as comment when comment not provided in reject', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    const resolution = await service.reject(action.id, approverContext(), {
      reason: 'Risk too high',
    });
    expect(resolution.comment).toBe('Risk too high');
  });

  it('throws when rejecting a non-existent action', async () => {
    await expect(service.reject('ghost', approverContext())).rejects.toThrow('not found');
  });

  // ─── cancel ───────────────────────────────────────────────────────────────

  it('cancels a pending action', async () => {
    const cancelEvents: any[] = [];
    bus.on('approval.cancelled', (e) => cancelEvents.push(e));

    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await service.cancel(action.id, makeContext({ userId: 'user-1' }));

    const updated = await store.getById(action.id);
    expect(updated!.status).toBe('cancelled');
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]!.data.cancelledBy).toBe('user-1');
  });

  it('throws when cancelling an already resolved action', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    await service.approve(action.id, approverContext());
    await expect(service.cancel(action.id, makeContext())).rejects.toThrow(/cannot be approved/);
  });

  // ─── queries ─────────────────────────────────────────────────────────────

  it('getPending returns matching actions', async () => {
    const t = makeTrigger();
    await service.createPendingAction('finance.transfer', {}, makeContext({ tenantId: 'a' }), t);
    await service.createPendingAction('finance.transfer', {}, makeContext({ tenantId: 'b' }), t);

    const results = await service.getPending({ tenantId: 'a' });
    expect(results).toHaveLength(1);
    expect(results[0]!.tenantId).toBe('a');
  });

  it('getById returns the action', async () => {
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      makeTrigger(),
    );
    const found = await service.getById(action.id);
    expect(found!.id).toBe(action.id);
  });

  it('getById returns null for unknown id', async () => {
    expect(await service.getById('unknown')).toBeNull();
  });

  // ─── processEscalations ───────────────────────────────────────────────────

  it('processEscalations delegates to EscalationManager', async () => {
    const result = await service.processEscalations();
    expect(result).toEqual({ escalated: 0, expired: 0 });
  });

  it('processEscalations uses registered triggers for escalation lookup', async () => {
    const trigger = makeTrigger({
      approvalConfig: {
        risk: 'high',
        approverRoles: ['manager'],
        timeoutMinutes: 90,
        escalation: {
          levels: [{ level: 1, afterMinutes: 30, approverRoles: ['director'] }],
        },
      },
    });
    service.addTrigger(trigger);

    const ctx = makeContext();
    const action = await service.createPendingAction('finance.transfer', {}, ctx, trigger);

    // Manually backdate updatedAt to simulate timeout elapsed
    await store.update({ ...action, updatedAt: new Date(Date.now() - 35 * 60 * 1000) });

    const result = await service.processEscalations();
    expect(result.escalated).toBe(1);
  });

  // ─── getByRequestId ───────────────────────────────────────────────────────

  it('getByRequestId returns only actions matching the given requestId', async () => {
    const trigger = makeTrigger();

    const ctxA = makeContext({ requestId: 'req-A' });
    const ctxB = makeContext({ requestId: 'req-B' });

    const actionA = await service.createPendingAction('finance.transfer', {}, ctxA, trigger);
    await service.createPendingAction('finance.transfer', {}, ctxB, trigger);

    const results = await service.getByRequestId('req-A');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(actionA.id);
    expect(results[0]!.requestId).toBe('req-A');
  });

  it('getByRequestId returns empty array when requestId matches nothing', async () => {
    const trigger = makeTrigger();
    await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext({ requestId: 'req-X' }),
      trigger,
    );

    const results = await service.getByRequestId('req-nonexistent');
    expect(results).toHaveLength(0);
  });

  // ─── processExpirations ───────────────────────────────────────────────────

  it('processExpirations returns 0 when nothing expired', async () => {
    const count = await service.processExpirations();
    expect(count).toBe(0);
  });

  it('processExpirations expires overdue actions', async () => {
    const trigger = makeTrigger();
    const action = await service.createPendingAction(
      'finance.transfer',
      {},
      makeContext(),
      trigger,
    );

    // Manually expire the action
    await store.update({ ...action, expiresAt: new Date(Date.now() - 5_000) });

    const count = await service.processExpirations();
    expect(count).toBe(1);

    const updated = await store.getById(action.id);
    expect(updated!.status).toBe('expired');
  });

  // ─── Approver authorization ───────────────────────────────────────────────

  describe('approver authorization', () => {
    async function pendingAction(trigger = makeTrigger()) {
      return service.createPendingAction(
        'finance.transfer',
        { amount: 100 },
        makeContext(),
        trigger,
      );
    }

    it('refuses to approve for a caller without an approver role, leaving the action pending', async () => {
      const denied: any[] = [];
      bus.on('security.approval.denied', (e) => denied.push(e));
      const action = await pendingAction();

      await expect(service.approve(action.id, makeContext())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );

      expect(toolExecutor.execute).not.toHaveBeenCalled();
      expect((await store.getById(action.id))!.status).toBe('pending');
      expect(denied).toHaveLength(1);
      expect(denied[0].data.decision).toBe('approve');
      expect(denied[0].data._context.userId).toBe('user-1');
    });

    it('refuses an approver from another tenant even with the right role', async () => {
      const action = await pendingAction();
      await expect(
        service.approve(action.id, approverContext({ tenantId: 'tenant-2' })),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(toolExecutor.execute).not.toHaveBeenCalled();
    });

    it('refuses to reject for an unauthorized caller', async () => {
      const action = await pendingAction();
      await expect(service.reject(action.id, makeContext())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      expect((await store.getById(action.id))!.status).toBe('pending');
    });

    it("admits any role when approverRoles contains '*'", async () => {
      const trigger = makeTrigger({
        approvalConfig: { risk: 'low', approverRoles: ['*'], timeoutMinutes: 60 },
      });
      const action = await pendingAction(trigger);
      const resolution = await service.approve(action.id, makeContext());
      expect(resolution.decision).toBe('approve');
    });

    it('admits a user listed in approverUsers', async () => {
      const action = await pendingAction();
      await store.update({ ...action, approverUsers: ['user-1'] });
      const resolution = await service.approve(action.id, makeContext());
      expect(resolution.decision).toBe('approve');
    });

    it('skips the check when authorizeApprovers is false', async () => {
      const open = new ApprovalService(store, notifier, toolExecutor, bus, {
        authorizeApprovers: false,
      });
      expect(open.authorizesApprovers).toBe(false);
      const action = await open.createPendingAction(
        'finance.transfer',
        { amount: 1 },
        makeContext(),
        makeTrigger(),
      );
      const resolution = await open.approve(action.id, makeContext({ tenantId: 'other' }));
      expect(resolution.decision).toBe('approve');
    });
  });

  // ─── Messages ─────────────────────────────────────────────────────────────

  describe('messages', () => {
    it('defaults to English texts', () => {
      expect(service.messages).toEqual(DEFAULT_APPROVAL_MESSAGES);
    });

    it('merges overrides over the defaults', () => {
      const localized = new ApprovalService(store, notifier, toolExecutor, bus, {
        messages: { suspendedSingle: "La acción '{toolName}' requiere aprobación." },
      });
      expect(localized.messages.suspendedSingle).toBe(
        "La acción '{toolName}' requiere aprobación.",
      );
      expect(localized.messages.suspendedMultiple).toBe(
        DEFAULT_APPROVAL_MESSAGES.suspendedMultiple,
      );
    });
  });
});
