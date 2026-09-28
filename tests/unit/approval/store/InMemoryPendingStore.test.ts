import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPendingStore } from '../../../../src/approval/store/InMemoryPendingStore.js';
import type { PendingAction } from '../../../../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date('2026-01-01T10:00:00Z');
  return {
    id: `action-${++idCounter}`,
    requestId: 'req-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-a',
    requestedBy: 'user-1',
    agentId: 'agent-1',
    toolName: 'finance.transfer',
    toolInput: { amount: 500 },
    description: 'Transfer funds',
    reason: 'High-value transaction',
    risk: 'high',
    approverRoles: ['manager'],
    currentEscalationLevel: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    savedContext: { executionContext: {} as any, agentConfig: 'agent-1' },
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('InMemoryPendingStore', () => {
  let store: InMemoryPendingStore;

  beforeEach(() => {
    store = new InMemoryPendingStore();
    idCounter = 0;
  });

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  it('creates and retrieves an action by id', async () => {
    const action = makeAction();
    await store.create(action);
    const found = await store.getById(action.id);
    expect(found).toMatchObject({ id: action.id, toolName: 'finance.transfer' });
  });

  it('returns null for unknown id', async () => {
    expect(await store.getById('no-such-id')).toBeNull();
  });

  it('updates an action', async () => {
    const action = makeAction();
    await store.create(action);
    await store.update({ ...action, status: 'approved' });
    const found = await store.getById(action.id);
    expect(found!.status).toBe('approved');
  });

  it('size reflects stored count', async () => {
    expect(store.size).toBe(0);
    await store.create(makeAction());
    await store.create(makeAction());
    expect(store.size).toBe(2);
  });

  // ─── getPending filters ────────────────────────────────────────────────────

  it('filters by single status', async () => {
    await store.create(makeAction({ status: 'pending' }));
    await store.create(makeAction({ status: 'escalated' }));
    await store.create(makeAction({ status: 'approved' }));

    const results = await store.getPending({ status: 'pending' });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('pending');
  });

  it('filters by status array', async () => {
    await store.create(makeAction({ status: 'pending' }));
    await store.create(makeAction({ status: 'escalated' }));
    await store.create(makeAction({ status: 'approved' }));

    const results = await store.getPending({ status: ['pending', 'escalated'] });
    expect(results).toHaveLength(2);
  });

  it('filters by tenantId', async () => {
    await store.create(makeAction({ tenantId: 'tenant-a' }));
    await store.create(makeAction({ tenantId: 'tenant-b' }));
    const results = await store.getPending({ tenantId: 'tenant-a' });
    expect(results).toHaveLength(1);
    expect(results[0]!.tenantId).toBe('tenant-a');
  });

  it('filters by requestedBy', async () => {
    await store.create(makeAction({ requestedBy: 'user-1' }));
    await store.create(makeAction({ requestedBy: 'user-2' }));
    const results = await store.getPending({ requestedBy: 'user-1' });
    expect(results).toHaveLength(1);
  });

  it('filters by agentId', async () => {
    await store.create(makeAction({ agentId: 'agent-a' }));
    await store.create(makeAction({ agentId: 'agent-b' }));
    const results = await store.getPending({ agentId: 'agent-a' });
    expect(results).toHaveLength(1);
  });

  it('filters by risk', async () => {
    await store.create(makeAction({ risk: 'low' }));
    await store.create(makeAction({ risk: 'high' }));
    const results = await store.getPending({ risk: 'high' });
    expect(results).toHaveLength(1);
    expect(results[0]!.risk).toBe('high');
  });

  it('filters by approverRoles (any-match)', async () => {
    await store.create(makeAction({ approverRoles: ['manager', 'vp'] }));
    await store.create(makeAction({ approverRoles: ['finance'] }));
    const results = await store.getPending({ approverRoles: ['vp'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.approverRoles).toContain('vp');
  });

  it('filters by createdAfter', async () => {
    const t1 = new Date('2026-01-01T08:00:00Z');
    const t2 = new Date('2026-01-01T12:00:00Z');
    await store.create(makeAction({ createdAt: t1 }));
    await store.create(makeAction({ createdAt: t2 }));
    const results = await store.getPending({ createdAfter: new Date('2026-01-01T10:00:00Z') });
    expect(results).toHaveLength(1);
    expect(results[0]!.createdAt.getTime()).toBe(t2.getTime());
  });

  it('filters by createdBefore', async () => {
    const t1 = new Date('2026-01-01T08:00:00Z');
    const t2 = new Date('2026-01-01T12:00:00Z');
    await store.create(makeAction({ createdAt: t1 }));
    await store.create(makeAction({ createdAt: t2 }));
    const results = await store.getPending({ createdBefore: new Date('2026-01-01T10:00:00Z') });
    expect(results).toHaveLength(1);
    expect(results[0]!.createdAt.getTime()).toBe(t1.getTime());
  });

  // ─── getPending sort ──────────────────────────────────────────────────────

  it('sorts by createdAt descending by default', async () => {
    const t1 = new Date('2026-01-01T08:00:00Z');
    const t2 = new Date('2026-01-01T09:00:00Z');
    await store.create(makeAction({ createdAt: t1 }));
    await store.create(makeAction({ createdAt: t2 }));
    const results = await store.getPending({});
    expect(results[0]!.createdAt.getTime()).toBe(t2.getTime());
    expect(results[1]!.createdAt.getTime()).toBe(t1.getTime());
  });

  it('sorts by expiresAt ascending', async () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const exp1 = new Date(now.getTime() + 30 * 60 * 1000);
    const exp2 = new Date(now.getTime() + 120 * 60 * 1000);
    await store.create(makeAction({ expiresAt: exp2 }));
    await store.create(makeAction({ expiresAt: exp1 }));
    const results = await store.getPending({ sortBy: 'expiresAt' });
    expect(results[0]!.expiresAt.getTime()).toBe(exp1.getTime());
  });

  it('sorts by risk descending (critical > high > medium > low)', async () => {
    await store.create(makeAction({ risk: 'low' }));
    await store.create(makeAction({ risk: 'critical' }));
    await store.create(makeAction({ risk: 'medium' }));
    const results = await store.getPending({ sortBy: 'risk' });
    expect(results[0]!.risk).toBe('critical');
    expect(results[2]!.risk).toBe('low');
  });

  it('applies limit', async () => {
    await store.create(makeAction());
    await store.create(makeAction());
    await store.create(makeAction());
    const results = await store.getPending({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  // ─── getExpired ────────────────────────────────────────────────────────────

  it('returns expired pending and escalated actions', async () => {
    const past = new Date(Date.now() - 10_000);
    const future = new Date(Date.now() + 60_000);
    await store.create(makeAction({ expiresAt: past, status: 'pending' }));
    await store.create(makeAction({ expiresAt: past, status: 'escalated' }));
    await store.create(makeAction({ expiresAt: past, status: 'approved' })); // terminal, skip
    await store.create(makeAction({ expiresAt: future, status: 'pending' })); // not expired yet

    const expired = await store.getExpired();
    expect(expired).toHaveLength(2);
    expect(expired.every((a) => a.status === 'pending' || a.status === 'escalated')).toBe(true);
  });

  // ─── count ────────────────────────────────────────────────────────────────

  it('counts actions matching filter', async () => {
    await store.create(makeAction({ tenantId: 'a', status: 'pending' }));
    await store.create(makeAction({ tenantId: 'a', status: 'approved' }));
    await store.create(makeAction({ tenantId: 'b', status: 'pending' }));

    expect(await store.count({ tenantId: 'a' })).toBe(2);
    expect(await store.count({ tenantId: 'a', status: 'pending' })).toBe(1);
    expect(await store.count({ tenantId: 'b' })).toBe(1);
  });

  // ─── deleteOlderThan ──────────────────────────────────────────────────────

  it('deletes terminal-status actions older than cutoff', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-03-01T00:00:00Z');
    const cutoff = new Date('2026-02-01T00:00:00Z');

    await store.create(makeAction({ status: 'approved', updatedAt: old }));
    await store.create(makeAction({ status: 'rejected', updatedAt: old }));
    await store.create(makeAction({ status: 'pending', updatedAt: old })); // not terminal
    await store.create(makeAction({ status: 'approved', updatedAt: recent })); // recent, not deleted

    const deleted = await store.deleteOlderThan(cutoff);
    expect(deleted).toBe(2);
    expect(store.size).toBe(2); // pending (old) + approved (recent)
  });

  it('deleteOlderThan also removes resume_failed terminal actions', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const cutoff = new Date('2026-02-01T00:00:00Z');

    await store.create(makeAction({ status: 'resume_failed', updatedAt: old }));
    const deleted = await store.deleteOlderThan(cutoff);
    expect(deleted).toBe(1);
  });

  // ─── claimForExecution ────────────────────────────────────────────────────

  it('claimForExecution: transitions pending → executing and returns the action', async () => {
    const action = makeAction({ status: 'pending' });
    await store.create(action);

    const claimed = await store.claimForExecution(action.id, { userId: 'approver-1' });

    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('executing');
    expect(claimed!.id).toBe(action.id);
  });

  it('claimForExecution: transitions escalated → executing', async () => {
    const action = makeAction({ status: 'escalated' });
    await store.create(action);

    const claimed = await store.claimForExecution(action.id, { userId: 'approver-2' });

    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('executing');
  });

  it('claimForExecution: persists the executing status in the store', async () => {
    const action = makeAction({ status: 'pending' });
    await store.create(action);

    await store.claimForExecution(action.id, { userId: 'approver-1' });

    const stored = await store.getById(action.id);
    expect(stored!.status).toBe('executing');
  });

  it('claimForExecution: returns null for non-existent action', async () => {
    const result = await store.claimForExecution('no-such-id', { userId: 'approver' });
    expect(result).toBeNull();
  });

  it('claimForExecution: returns null when action is already executing (concurrent guard)', async () => {
    const action = makeAction({ status: 'pending' });
    await store.create(action);

    const first = await store.claimForExecution(action.id, { userId: 'u1' });
    expect(first).not.toBeNull();

    // Second claim — same action is now 'executing', not claimable
    const second = await store.claimForExecution(action.id, { userId: 'u2' });
    expect(second).toBeNull();
  });

  it('claimForExecution: returns null for completed action', async () => {
    const action = makeAction({ status: 'completed' });
    await store.create(action);

    const result = await store.claimForExecution(action.id, { userId: 'u' });
    expect(result).toBeNull();
  });

  it('claimForExecution: returns null for rejected action', async () => {
    const action = makeAction({ status: 'rejected' });
    await store.create(action);

    const result = await store.claimForExecution(action.id, { userId: 'u' });
    expect(result).toBeNull();
  });

  it('claimForExecution: returns null for tool_completed action', async () => {
    const action = makeAction({ status: 'tool_completed' });
    await store.create(action);

    const result = await store.claimForExecution(action.id, { userId: 'u' });
    expect(result).toBeNull();
  });
});
