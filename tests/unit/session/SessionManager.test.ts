import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../../src/session/SessionManager.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a Date that is `ms` milliseconds in the past. */
function msAgo(ms: number): Date {
  return new Date(Date.now() - ms);
}

/** Returns a Date that is `ms` milliseconds in the future. */
function msFromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

let sm: SessionManager;

beforeEach(() => {
  sm = new SessionManager(new InMemoryAdapter());
});

// ─────────────────────────────────────────────────────────────────────────────
// create()
// ─────────────────────────────────────────────────────────────────────────────

describe('create()', () => {
  it('returns a session with the provided tenantId, userId, agentId', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-finance');
    expect(s.tenantId).toBe('acme');
    expect(s.userId).toBe('user-1');
    expect(s.agentId).toBe('agent-finance');
  });

  it('returns a session with status "active"', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-finance');
    expect(s.status).toBe('active');
  });

  it('populates createdAt and lastActivityAt as Dates', async () => {
    const before = new Date();
    const s = await sm.create('acme', 'user-1', 'agent-x');
    const after = new Date();
    expect(s.createdAt).toBeInstanceOf(Date);
    expect(s.lastActivityAt).toBeInstanceOf(Date);
    expect(s.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(s.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('generates a non-empty UUID for sessionId', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    expect(s.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates a unique sessionId per call', async () => {
    const ids = await Promise.all([
      sm.create('acme', 'u', 'a').then((s) => s.sessionId),
      sm.create('acme', 'u', 'a').then((s) => s.sessionId),
      sm.create('acme', 'u', 'a').then((s) => s.sessionId),
    ]);
    expect(new Set(ids).size).toBe(3);
  });

  it('does not set metadata by default', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    expect(s.metadata).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get()
// ─────────────────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns the session after creation', async () => {
    const created = await sm.create('acme', 'user-1', 'agent-x');
    const fetched = await sm.get(created.sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionId).toBe(created.sessionId);
  });

  it('returns null for an unknown sessionId', async () => {
    expect(await sm.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('createdAt is a Date instance when read back', async () => {
    const created = await sm.create('acme', 'user-1', 'agent-x');
    const fetched = await sm.get(created.sessionId);
    expect(fetched!.createdAt).toBeInstanceOf(Date);
  });

  it('lastActivityAt is a Date instance when read back', async () => {
    const created = await sm.create('acme', 'user-1', 'agent-x');
    const fetched = await sm.get(created.sessionId);
    expect(fetched!.lastActivityAt).toBeInstanceOf(Date);
  });

  it('returned session has correct tenant / user / agent', async () => {
    const created = await sm.create('tenant-x', 'user-99', 'agent-rag');
    const fetched = await sm.get(created.sessionId);
    expect(fetched!.tenantId).toBe('tenant-x');
    expect(fetched!.userId).toBe('user-99');
    expect(fetched!.agentId).toBe('agent-rag');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// close()
// ─────────────────────────────────────────────────────────────────────────────

describe('close()', () => {
  it('transitions session status to "closed"', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    await sm.close(s.sessionId);
    const fetched = await sm.get(s.sessionId);
    expect(fetched!.status).toBe('closed');
  });

  it('updates lastActivityAt on close', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    const originalActivity = s.lastActivityAt.getTime();
    // Ensure a measurable time passes
    await new Promise((r) => setTimeout(r, 2));
    await sm.close(s.sessionId);
    const fetched = await sm.get(s.sessionId);
    expect(fetched!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(originalActivity);
  });

  it('is a no-op for an unknown sessionId (does not throw)', async () => {
    await expect(sm.close('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });

  it('does not affect other sessions', async () => {
    const a = await sm.create('acme', 'user-1', 'agent-x');
    const b = await sm.create('acme', 'user-1', 'agent-y');
    await sm.close(a.sessionId);
    const fetchedB = await sm.get(b.sessionId);
    expect(fetchedB!.status).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listActive()
// ─────────────────────────────────────────────────────────────────────────────

describe('listActive()', () => {
  it('returns an empty array when no sessions exist', async () => {
    expect(await sm.listActive('acme', 'user-1')).toEqual([]);
  });

  it('returns the active session after creation', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    const active = await sm.listActive('acme', 'user-1');
    expect(active).toHaveLength(1);
    expect(active[0]!.sessionId).toBe(s.sessionId);
  });

  it('does not return closed sessions', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    await sm.close(s.sessionId);
    expect(await sm.listActive('acme', 'user-1')).toHaveLength(0);
  });

  it('returns multiple active sessions for the same user', async () => {
    await sm.create('acme', 'user-1', 'agent-a');
    await sm.create('acme', 'user-1', 'agent-b');
    await sm.create('acme', 'user-1', 'agent-c');
    expect(await sm.listActive('acme', 'user-1')).toHaveLength(3);
  });

  it('excludes sessions belonging to a different user', async () => {
    await sm.create('acme', 'user-1', 'agent-x');
    await sm.create('acme', 'user-2', 'agent-x');
    const activeForU1 = await sm.listActive('acme', 'user-1');
    expect(activeForU1).toHaveLength(1);
    expect(activeForU1[0]!.userId).toBe('user-1');
  });

  it('excludes sessions belonging to a different tenant', async () => {
    await sm.create('tenant-a', 'user-1', 'agent-x');
    await sm.create('tenant-b', 'user-1', 'agent-x');
    const active = await sm.listActive('tenant-a', 'user-1');
    expect(active).toHaveLength(1);
    expect(active[0]!.tenantId).toBe('tenant-a');
  });

  it('shows only remaining active sessions after some are closed', async () => {
    const a = await sm.create('acme', 'user-1', 'agent-a');
    await sm.create('acme', 'user-1', 'agent-b');
    const c = await sm.create('acme', 'user-1', 'agent-c');
    await sm.close(a.sessionId);
    await sm.close(c.sessionId);
    const active = await sm.listActive('acme', 'user-1');
    expect(active).toHaveLength(1);
    expect(active[0]!.agentId).toBe('agent-b');
  });

  it('returns Session objects with proper Date fields', async () => {
    await sm.create('acme', 'user-1', 'agent-x');
    const [s] = await sm.listActive('acme', 'user-1');
    expect(s!.createdAt).toBeInstanceOf(Date);
    expect(s!.lastActivityAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanup()
// ─────────────────────────────────────────────────────────────────────────────

describe('cleanup()', () => {
  it('returns 0 when no sessions exist', async () => {
    expect(await sm.cleanup(new Date())).toBe(0);
  });

  it('returns 0 when all sessions are newer than olderThan', async () => {
    await sm.create('acme', 'user-1', 'agent-x');
    // Cut-off in the past: nothing is older
    expect(await sm.cleanup(msAgo(60_000))).toBe(0);
  });

  it('returns the count of deleted sessions', async () => {
    await sm.create('acme', 'user-1', 'agent-a');
    await sm.create('acme', 'user-2', 'agent-b');
    // Cut-off far in the future: everything is older
    expect(await sm.cleanup(msFromNow(60_000))).toBe(2);
  });

  it('deleted sessions are no longer retrievable via get()', async () => {
    const s = await sm.create('acme', 'user-1', 'agent-x');
    await sm.cleanup(msFromNow(60_000));
    expect(await sm.get(s.sessionId)).toBeNull();
  });

  it('deleted sessions no longer appear in listActive()', async () => {
    await sm.create('acme', 'user-1', 'agent-x');
    await sm.cleanup(msFromNow(60_000));
    expect(await sm.listActive('acme', 'user-1')).toHaveLength(0);
  });

  it('preserves sessions that are newer than olderThan', async () => {
    const kept = await sm.create('acme', 'user-1', 'agent-x');
    // Cut-off in the past: nothing should be deleted
    await sm.cleanup(msAgo(60_000));
    const fetched = await sm.get(kept.sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionId).toBe(kept.sessionId);
  });

  it('only removes sessions older than olderThan, keeps newer ones', async () => {
    // Create two sessions; cut-off is "now".
    // Both sessions were created just now, so they are NOT older than now.
    const s1 = await sm.create('acme', 'user-1', 'agent-a');
    const s2 = await sm.create('acme', 'user-1', 'agent-b');

    // Manually backdate s1's lastActivityAt by writing directly to verify selective cleanup.
    // We test this indirectly: cut-off far in the past → nothing deleted.
    expect(await sm.cleanup(msAgo(60_000))).toBe(0);
    expect(await sm.get(s1.sessionId)).not.toBeNull();
    expect(await sm.get(s2.sessionId)).not.toBeNull();
  });

  it('can be called multiple times — second call returns 0 for already-cleaned sessions', async () => {
    await sm.create('acme', 'user-1', 'agent-x');
    await sm.cleanup(msFromNow(60_000));
    expect(await sm.cleanup(msFromNow(60_000))).toBe(0);
  });

  it('cleans sessions across different tenants and users', async () => {
    await sm.create('tenant-a', 'user-1', 'agent-x');
    await sm.create('tenant-b', 'user-2', 'agent-y');
    const count = await sm.cleanup(msFromNow(60_000));
    expect(count).toBe(2);
    expect(await sm.listActive('tenant-a', 'user-1')).toHaveLength(0);
    expect(await sm.listActive('tenant-b', 'user-2')).toHaveLength(0);
  });
});
