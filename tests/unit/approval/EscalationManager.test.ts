import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EscalationManager } from '../../../src/approval/EscalationManager.js';
import { InMemoryPendingStore } from '../../../src/approval/store/InMemoryPendingStore.js';
import { EventBus } from '../../../src/events/EventBus.js';
import type { ApprovalNotifier } from '../../../src/approval/notification/ApprovalNotifier.js';
import type { ApprovalTrigger, PendingAction } from '../../../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNotifier(): ApprovalNotifier {
  return {
    notifyApprovers: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyResolution: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyEscalation: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
    notifyExpiration: vi.fn().mockResolvedValue({ channelsSent: [], channelsFailed: [] }),
  } as unknown as ApprovalNotifier;
}

function makeTrigger(overrides: Partial<ApprovalTrigger> = {}): ApprovalTrigger {
  return {
    id: 'trigger-1',
    name: 'Test',
    description: 'Test trigger',
    enabled: true,
    scope: { tools: ['finance.transfer'] },
    conditions: [{ type: 'always' }],
    approvalConfig: {
      risk: 'high',
      approverRoles: ['manager'],
      timeoutMinutes: 60,
      escalation: {
        levels: [
          { level: 1, afterMinutes: 30, approverRoles: ['director'] },
          { level: 2, afterMinutes: 45, approverRoles: ['cfo'] },
        ],
      },
    },
    ...overrides,
  };
}

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date();
  return {
    id: 'action-1',
    requestId: 'req-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    requestedBy: 'user-1',
    agentId: 'agent-1',
    toolName: 'finance.transfer',
    toolInput: {},
    description: 'Transfer funds',
    reason: 'High value',
    risk: 'high',
    approverRoles: ['manager'],
    currentEscalationLevel: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 90 * 60 * 1000), // 90 min from now
    savedContext: { executionContext: {} as any, agentConfig: 'agent-1' },
    metadata: { triggerId: 'trigger-1' },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EscalationManager', () => {
  let store: InMemoryPendingStore;
  let notifier: ApprovalNotifier;
  let bus: EventBus;
  let manager: EscalationManager;

  beforeEach(() => {
    store = new InMemoryPendingStore();
    notifier = makeNotifier();
    bus = new EventBus();
    manager = new EscalationManager(store, notifier, bus);
  });

  // ─── No escalation needed yet ─────────────────────────────────────────────

  it('returns zero counts when no actions are overdue', async () => {
    const action = makeAction(); // updatedAt = now, expiresAt = now+90min
    await store.create(action);

    const result = await manager.process([makeTrigger()]);
    expect(result).toEqual({ escalated: 0, expired: 0 });
  });

  // ─── Escalation fires after timeout ───────────────────────────────────────

  it('escalates an action to level 1 after afterMinutes elapsed', async () => {
    const updatedAt = new Date(Date.now() - 31 * 60 * 1000); // 31 min ago
    const action = makeAction({ updatedAt });
    await store.create(action);

    const escalatedEvents: any[] = [];
    bus.on('approval.escalated', (e) => escalatedEvents.push(e));

    const result = await manager.process([makeTrigger()]);
    expect(result.escalated).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('escalated');
    expect(updated!.currentEscalationLevel).toBe(1);
    expect(updated!.approverRoles).toEqual(['director']);

    expect(notifier.notifyEscalation).toHaveBeenCalledOnce();
    expect(escalatedEvents).toHaveLength(1);
    expect(escalatedEvents[0].data).toMatchObject({ fromLevel: 0, toLevel: 1 });
  });

  // ─── No escalation within timeout ─────────────────────────────────────────

  it('does not escalate when timeout has not elapsed', async () => {
    const updatedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago (< 30 min threshold)
    const action = makeAction({ updatedAt });
    await store.create(action);

    const result = await manager.process([makeTrigger()]);
    expect(result.escalated).toBe(0);
    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('pending');
  });

  // ─── Level 2 escalation ───────────────────────────────────────────────────

  it('escalates to level 2 when already at level 1', async () => {
    const updatedAt = new Date(Date.now() - 46 * 60 * 1000); // 46 min ago (> 45 min for L2)
    const action = makeAction({
      currentEscalationLevel: 1,
      status: 'escalated',
      updatedAt,
      approverRoles: ['director'],
    });
    await store.create(action);

    const result = await manager.process([makeTrigger()]);
    expect(result.escalated).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.currentEscalationLevel).toBe(2);
    expect(updated!.approverRoles).toEqual(['cfo']);
  });

  // ─── Expiration when no more levels and expiresAt passed ─────────────────

  it('expires action when at max escalation level and expiresAt is past', async () => {
    const updatedAt = new Date(Date.now() - 50 * 60 * 1000);
    const expiresAt = new Date(Date.now() - 5 * 60 * 1000); // already expired
    const action = makeAction({
      currentEscalationLevel: 2,
      status: 'escalated',
      updatedAt,
      expiresAt,
      approverRoles: ['cfo'],
    });
    await store.create(action);

    const expiredEvents: any[] = [];
    bus.on('approval.expired', (e) => expiredEvents.push(e));

    const result = await manager.process([makeTrigger()]);
    expect(result.expired).toBe(1);

    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('expired');
    expect(expiredEvents).toHaveLength(1);
    expect(notifier.notifyExpiration).toHaveBeenCalledOnce();
  });

  // ─── Trigger without escalation config ───────────────────────────────────

  it('expires action with no escalation config when expiresAt is past', async () => {
    const expiresAt = new Date(Date.now() - 5_000);
    const action = makeAction({ expiresAt, metadata: { triggerId: 'no-escalation-trigger' } });
    await store.create(action);

    const noEscTrigger = makeTrigger({
      id: 'no-escalation-trigger',
      approvalConfig: { risk: 'low', approverRoles: ['manager'] }, // no escalation
    });

    const result = await manager.process([noEscTrigger]);
    expect(result.expired).toBe(1);
    const updated = await store.getById('action-1');
    expect(updated!.status).toBe('expired');
  });

  // ─── Unknown trigger ID ───────────────────────────────────────────────────

  it('handles action whose triggerId does not match any trigger', async () => {
    const action = makeAction({ metadata: { triggerId: 'ghost-trigger' } });
    await store.create(action);

    const result = await manager.process([makeTrigger()]);
    // No matching trigger means no escalation, no expiry (expiresAt in future)
    expect(result.escalated).toBe(0);
    expect(result.expired).toBe(0);
  });

  // ─── Multiple actions processed ───────────────────────────────────────────

  it('processes multiple actions in one pass', async () => {
    const updatedAt = new Date(Date.now() - 35 * 60 * 1000);
    await store.create(makeAction({ id: 'a1', updatedAt }));
    await store.create(makeAction({ id: 'a2', updatedAt }));

    const result = await manager.process([makeTrigger()]);
    expect(result.escalated).toBe(2);
  });
});
