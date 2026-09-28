import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExpirationManager } from '../../../src/approval/ExpirationManager.js';
import { InMemoryPendingStore } from '../../../src/approval/store/InMemoryPendingStore.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { ApprovalNotifier } from '../../../src/approval/notification/ApprovalNotifier.js';
import type { ToolExecutor } from '../../../src/tools/ToolExecutor.js';
import type { PendingAction, ExpirationPolicy } from '../../../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNotifier(): ApprovalNotifier {
  return {
    notifyApprovers: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyResolution: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyEscalation: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyExpiration: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
  } as unknown as ApprovalNotifier;
}

function makeToolExecutor(result: any = { content: 'ok' }): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as ToolExecutor;
}

function makeExpiredAction(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date();
  return {
    id: 'action-1',
    requestId: 'req-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    requestedBy: 'user-1',
    agentId: 'agent-1',
    toolName: 'finance.transfer',
    toolInput: { amount: 100 },
    description: 'Transfer funds',
    reason: 'Test',
    risk: 'low',
    approverRoles: ['manager'],
    currentEscalationLevel: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() - 5_000), // already expired
    savedContext: { executionContext: {} as any, agentConfig: 'agent-1' },
    metadata: {},
    ...overrides,
  };
}

function makePolicy(overrides: Partial<ExpirationPolicy> = {}): ExpirationPolicy {
  return {
    onExpire: 'expire',
    notifyRequestor: true,
    notifyApprovers: true,
    checkIntervalMs: 60_000,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExpirationManager', () => {
  let store: InMemoryPendingStore;
  let notifier: ApprovalNotifier;
  let bus: EventBus;

  beforeEach(() => {
    store = new InMemoryPendingStore();
    notifier = makeNotifier();
    bus = new EventBus();
  });

  // ─── No expired actions ───────────────────────────────────────────────────

  it('returns 0 when no expired actions', async () => {
    const manager = new ExpirationManager(store, notifier, bus, makePolicy());
    const action = makeExpiredAction({ expiresAt: new Date(Date.now() + 60_000) }); // not expired
    await store.create(action);
    expect(await manager.process()).toBe(0);
  });

  // ─── Policy: expire ───────────────────────────────────────────────────────

  it('marks actions as expired with expire policy', async () => {
    const manager = new ExpirationManager(store, notifier, bus, makePolicy({ onExpire: 'expire' }));
    await store.create(makeExpiredAction());

    const expiredEvents: any[] = [];
    bus.on('approval.expired', (e) => expiredEvents.push(e));

    const count = await manager.process();
    expect(count).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('expired');
    expect(notifier.notifyExpiration).toHaveBeenCalledOnce();
    expect(expiredEvents[0]!.data.expirationAction).toBe('expire');
  });

  // ─── Policy: auto_reject ──────────────────────────────────────────────────

  it('auto-rejects actions with auto_reject policy', async () => {
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_reject' }),
    );
    await store.create(makeExpiredAction());

    const expiredEvents: any[] = [];
    bus.on('approval.expired', (e) => expiredEvents.push(e));

    const count = await manager.process();
    expect(count).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('rejected');
    expect(updated!.resolution!.decision).toBe('reject');
    expect(updated!.resolution!.resolvedBy).toBe('system');
    expect(updated!.resolution!.comment).toContain('timeout');
    expect(notifier.notifyExpiration).toHaveBeenCalledOnce();
    expect(expiredEvents[0]!.data.expirationAction).toBe('auto_reject');
  });

  // ─── Policy: auto_approve for low risk ────────────────────────────────────

  it('auto-approves low-risk actions with auto_approve policy', async () => {
    const toolExecutor = makeToolExecutor({ content: 'executed' });
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_approve' }),
      toolExecutor,
    );
    await store.create(makeExpiredAction({ risk: 'low' }));

    const expiredEvents: any[] = [];
    const executedEvents: any[] = [];
    bus.on('approval.expired', (e) => expiredEvents.push(e));
    bus.on('approval.executed', (e) => executedEvents.push(e));

    const count = await manager.process();
    expect(count).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('completed');
    expect(updated!.resolution!.decision).toBe('approve');
    expect(updated!.resolution!.resolvedBy).toBe('system');
    expect(toolExecutor.execute).toHaveBeenCalledOnce();
    expect(expiredEvents[0]!.data.expirationAction).toBe('auto_approve');
    expect(executedEvents).toHaveLength(1);
    expect(notifier.notifyExpiration).toHaveBeenCalledOnce();
  });

  // ─── Safety guard: auto_approve skipped for non-low risk ─────────────────

  it('falls back to expire for non-low risk with auto_approve policy', async () => {
    const toolExecutor = makeToolExecutor();
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_approve' }),
      toolExecutor,
    );
    await store.create(makeExpiredAction({ risk: 'high' }));

    const count = await manager.process();
    expect(count).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('expired'); // fallback to expire
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('falls back to expire for critical risk with auto_approve policy', async () => {
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_approve' }),
    );
    await store.create(makeExpiredAction({ risk: 'critical' }));

    await manager.process();
    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('expired');
  });

  // ─── Notification flags ───────────────────────────────────────────────────

  it('skips notification when both notify flags are false', async () => {
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'expire', notifyRequestor: false, notifyApprovers: false }),
    );
    await store.create(makeExpiredAction());

    await manager.process();
    expect(notifier.notifyExpiration).not.toHaveBeenCalled();
  });

  // ─── Tool executor failure on auto_approve ────────────────────────────────

  it('marks as failed when tool execution throws during auto_approve', async () => {
    const failingExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('tool crashed')),
    } as unknown as ToolExecutor;
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_approve' }),
      failingExecutor,
    );
    await store.create(makeExpiredAction({ risk: 'low' }));

    const failedEvents: any[] = [];
    bus.on('approval.execution_failed', (e) => failedEvents.push(e));

    const count = await manager.process();
    expect(count).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('failed');
    expect(failedEvents).toHaveLength(1);
  });

  // ─── checkIntervalMs exposed ──────────────────────────────────────────────

  it('exposes checkIntervalMs from policy', () => {
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ checkIntervalMs: 30_000 }),
    );
    expect(manager.checkIntervalMs).toBe(30_000);
  });

  // ─── Multiple expired actions ─────────────────────────────────────────────

  it('processes multiple expired actions in one call', async () => {
    const manager = new ExpirationManager(store, notifier, bus, makePolicy({ onExpire: 'expire' }));
    await store.create(makeExpiredAction({ id: 'a1' }));
    await store.create(makeExpiredAction({ id: 'a2' }));
    await store.create(makeExpiredAction({ id: 'a3', expiresAt: new Date(Date.now() + 60_000) }));

    const count = await manager.process();
    expect(count).toBe(2);
  });

  // ─── Escalated actions also processed ────────────────────────────────────

  it('processes escalated actions that have expired', async () => {
    const manager = new ExpirationManager(
      store,
      notifier,
      bus,
      makePolicy({ onExpire: 'auto_reject' }),
    );
    await store.create(makeExpiredAction({ status: 'escalated' }));

    const count = await manager.process();
    expect(count).toBe(1);
    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('rejected');
  });
});
