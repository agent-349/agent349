import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditStore } from '../../../../src/audit/store/InMemoryAuditStore.js';
import type { AuditRecord, AuditQuery } from '../../../../src/types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  _seq++;
  return {
    id: `rec-${_seq}`,
    timestamp: new Date('2026-01-15T12:00:00Z'),
    requestId: 'req-001',
    sessionId: 'sess-001',
    tenantId: 'tenant-a',
    userId: 'user-1',
    agentId: 'agent-1',
    category: 'tool',
    action: 'call_end',
    outcome: 'success',
    severity: 'info',
    ...overrides,
  };
}

function baseQuery(overrides: Partial<AuditQuery> = {}): AuditQuery {
  return {
    dateRange: { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
    ...overrides,
  };
}

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    _seq = 0;
    store = new InMemoryAuditStore();
  });

  // ── writeBatch / getById ───────────────────────────────────────────────────

  describe('writeBatch() + getById()', () => {
    it('persists records and retrieves them by id', async () => {
      const r = makeRecord();
      await store.writeBatch([r]);
      const found = await store.getById(r.id);
      expect(found).toEqual(r);
    });

    it('returns null for an unknown id', async () => {
      expect(await store.getById('not-found')).toBeNull();
    });

    it('persists multiple records in one batch', async () => {
      const records = [makeRecord(), makeRecord(), makeRecord()];
      await store.writeBatch(records);
      expect(store.recordCount).toBe(3);
    });
  });

  // ── getByRequestId ─────────────────────────────────────────────────────────

  describe('getByRequestId()', () => {
    it('returns all records for a requestId in chronological order', async () => {
      const r1 = makeRecord({ requestId: 'req-X', timestamp: new Date('2026-01-15T10:00:00Z') });
      const r2 = makeRecord({ requestId: 'req-X', timestamp: new Date('2026-01-15T10:01:00Z') });
      const r3 = makeRecord({ requestId: 'req-Y' });
      await store.writeBatch([r2, r1, r3]);
      const results = await store.getByRequestId('req-X');
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe(r1.id);
      expect(results[1]!.id).toBe(r2.id);
    });

    it('returns empty array for unknown requestId', async () => {
      expect(await store.getByRequestId('none')).toEqual([]);
    });
  });

  // ── query — identity filters ───────────────────────────────────────────────

  describe('query() — identity filters', () => {
    it('filters by tenantId', async () => {
      await store.writeBatch([makeRecord({ tenantId: 'a' }), makeRecord({ tenantId: 'b' })]);
      const result = await store.query(baseQuery({ tenantId: 'a' }));
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.tenantId).toBe('a');
    });

    it('filters by userId', async () => {
      await store.writeBatch([makeRecord({ userId: 'u1' }), makeRecord({ userId: 'u2' })]);
      const result = await store.query(baseQuery({ userId: 'u1' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by sessionId', async () => {
      await store.writeBatch([makeRecord({ sessionId: 's1' }), makeRecord({ sessionId: 's2' })]);
      const result = await store.query(baseQuery({ sessionId: 's1' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by requestId', async () => {
      await store.writeBatch([makeRecord({ requestId: 'rA' }), makeRecord({ requestId: 'rB' })]);
      const result = await store.query(baseQuery({ requestId: 'rA' }));
      expect(result.records).toHaveLength(1);
    });
  });

  // ── query — event filters ──────────────────────────────────────────────────

  describe('query() — event filters', () => {
    it('filters by single category', async () => {
      await store.writeBatch([makeRecord({ category: 'tool' }), makeRecord({ category: 'llm' })]);
      const result = await store.query(baseQuery({ category: 'tool' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by array of categories', async () => {
      await store.writeBatch([
        makeRecord({ category: 'tool' }),
        makeRecord({ category: 'llm' }),
        makeRecord({ category: 'security' }),
      ]);
      const result = await store.query(baseQuery({ category: ['tool', 'llm'] }));
      expect(result.records).toHaveLength(2);
    });

    it('filters by action', async () => {
      await store.writeBatch([
        makeRecord({ action: 'call_end' }),
        makeRecord({ action: 'call_start' }),
      ]);
      const result = await store.query(baseQuery({ action: 'call_end' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by single outcome', async () => {
      await store.writeBatch([
        makeRecord({ outcome: 'success' }),
        makeRecord({ outcome: 'failure' }),
      ]);
      const result = await store.query(baseQuery({ outcome: 'failure' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by array of outcomes', async () => {
      await store.writeBatch([
        makeRecord({ outcome: 'success' }),
        makeRecord({ outcome: 'failure' }),
        makeRecord({ outcome: 'blocked' }),
      ]);
      const result = await store.query(baseQuery({ outcome: ['failure', 'blocked'] }));
      expect(result.records).toHaveLength(2);
    });

    it('filters by severity', async () => {
      await store.writeBatch([
        makeRecord({ severity: 'info' }),
        makeRecord({ severity: 'critical' }),
      ]);
      const result = await store.query(baseQuery({ severity: 'critical' }));
      expect(result.records).toHaveLength(1);
    });
  });

  // ── query — date range ─────────────────────────────────────────────────────

  describe('query() — date range filter', () => {
    it('only returns records within the date range', async () => {
      await store.writeBatch([
        makeRecord({ timestamp: new Date('2026-01-10') }),
        makeRecord({ timestamp: new Date('2026-03-10') }),
        makeRecord({ timestamp: new Date('2026-06-10') }),
      ]);
      const result = await store.query({
        dateRange: { from: new Date('2026-02-01'), to: new Date('2026-04-30') },
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.timestamp.getMonth()).toBe(2); // March
    });
  });

  // ── query — resource filters ───────────────────────────────────────────────

  describe('query() — resource filters', () => {
    it('filters by resourceType', async () => {
      await store.writeBatch([
        makeRecord({ resource: { type: 'tool', id: 'tool-1' } }),
        makeRecord({ resource: { type: 'document', id: 'doc-1' } }),
      ]);
      const result = await store.query(baseQuery({ resourceType: 'tool' }));
      expect(result.records).toHaveLength(1);
    });

    it('filters by resourceId', async () => {
      await store.writeBatch([
        makeRecord({ resource: { type: 'tool', id: 'tool-abc' } }),
        makeRecord({ resource: { type: 'tool', id: 'tool-xyz' } }),
      ]);
      const result = await store.query(baseQuery({ resourceId: 'tool-abc' }));
      expect(result.records).toHaveLength(1);
    });
  });

  // ── query — text search ────────────────────────────────────────────────────

  describe('query() — searchText', () => {
    it('matches records whose summary contains the search text', async () => {
      await store.writeBatch([
        makeRecord({ detail: { summary: 'Access denied for user' } }),
        makeRecord({ detail: { summary: 'Tool call completed' } }),
      ]);
      const result = await store.query(baseQuery({ searchText: 'Access denied' }));
      expect(result.records).toHaveLength(1);
    });

    it('is case-insensitive', async () => {
      await store.writeBatch([makeRecord({ detail: { summary: 'SECURITY EVENT' } })]);
      const result = await store.query(baseQuery({ searchText: 'security' }));
      expect(result.records).toHaveLength(1);
    });
  });

  // ── query — sorting ────────────────────────────────────────────────────────

  describe('query() — sorting', () => {
    it('sorts by timestamp desc by default', async () => {
      const jan = new Date('2026-01-15T12:00:00Z');
      const jun = new Date('2026-06-15T12:00:00Z');
      await store.writeBatch([makeRecord({ timestamp: jan }), makeRecord({ timestamp: jun })]);
      const result = await store.query(baseQuery());
      expect(result.records[0]!.timestamp.getTime()).toBe(jun.getTime()); // June first (desc)
    });

    it('sorts by timestamp asc when specified', async () => {
      const jan = new Date('2026-01-15T12:00:00Z');
      const jun = new Date('2026-06-15T12:00:00Z');
      await store.writeBatch([makeRecord({ timestamp: jun }), makeRecord({ timestamp: jan })]);
      const result = await store.query(baseQuery({ sortBy: 'timestamp', sortOrder: 'asc' }));
      expect(result.records[0]!.timestamp.getTime()).toBe(jan.getTime()); // January first (asc)
    });

    it('sorts by severity desc', async () => {
      await store.writeBatch([
        makeRecord({ severity: 'info' }),
        makeRecord({ severity: 'critical' }),
        makeRecord({ severity: 'warning' }),
      ]);
      const result = await store.query(baseQuery({ sortBy: 'severity', sortOrder: 'desc' }));
      expect(result.records[0]!.severity).toBe('critical');
      expect(result.records[result.records.length - 1]!.severity).toBe('info');
    });
  });

  // ── query — pagination ─────────────────────────────────────────────────────

  describe('query() — pagination', () => {
    it('respects limit', async () => {
      await store.writeBatch([makeRecord(), makeRecord(), makeRecord(), makeRecord()]);
      const result = await store.query(baseQuery({ limit: 2 }));
      expect(result.records).toHaveLength(2);
      expect(result.total).toBe(4);
      expect(result.hasMore).toBe(true);
    });

    it('respects offset', async () => {
      await store.writeBatch([
        makeRecord({ action: 'a1' }),
        makeRecord({ action: 'a2' }),
        makeRecord({ action: 'a3' }),
      ]);
      const page2 = await store.query(baseQuery({ limit: 1, offset: 2, sortOrder: 'asc' }));
      expect(page2.records).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });

    it('hasMore is false when all records fit on one page', async () => {
      await store.writeBatch([makeRecord()]);
      const result = await store.query(baseQuery({ limit: 10 }));
      expect(result.hasMore).toBe(false);
    });
  });

  // ── count ──────────────────────────────────────────────────────────────────

  describe('count()', () => {
    it('counts all records without filters', async () => {
      await store.writeBatch([makeRecord(), makeRecord()]);
      expect(await store.count({})).toBe(2);
    });

    it('counts only records matching the filter', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 'a' }),
        makeRecord({ tenantId: 'b' }),
        makeRecord({ tenantId: 'a' }),
      ]);
      expect(await store.count({ tenantId: 'a' })).toBe(2);
    });
  });

  // ── aggregate ─────────────────────────────────────────────────────────────

  describe('aggregate()', () => {
    it('groups by category', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 't1', category: 'tool' }),
        makeRecord({ tenantId: 't1', category: 'tool' }),
        makeRecord({ tenantId: 't1', category: 'llm' }),
      ]);
      const results = await store.aggregate(
        't1',
        { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
        'category',
      );
      const toolBucket = results.find((r) => r.key === 'tool');
      const llmBucket = results.find((r) => r.key === 'llm');
      expect(toolBucket?.count).toBe(2);
      expect(llmBucket?.count).toBe(1);
    });

    it('groups by outcome', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 't1', outcome: 'success' }),
        makeRecord({ tenantId: 't1', outcome: 'failure' }),
        makeRecord({ tenantId: 't1', outcome: 'success' }),
      ]);
      const results = await store.aggregate(
        't1',
        { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
        'outcome',
      );
      expect(results.find((r) => r.key === 'success')?.count).toBe(2);
      expect(results.find((r) => r.key === 'failure')?.count).toBe(1);
    });

    it('scopes aggregate to the given tenantId', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 't1', category: 'tool' }),
        makeRecord({ tenantId: 't2', category: 'llm' }),
      ]);
      const results = await store.aggregate(
        't1',
        { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
        'category',
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe('tool');
    });

    it('computes avgDurationMs when metrics are present', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 't1', category: 'tool', metrics: { durationMs: 100 } }),
        makeRecord({ tenantId: 't1', category: 'tool', metrics: { durationMs: 200 } }),
      ]);
      const results = await store.aggregate(
        't1',
        { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
        'category',
      );
      expect(results[0]!.avgDurationMs).toBe(150);
    });

    it('groups by day', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 't1', timestamp: new Date('2026-01-10T10:00:00Z') }),
        makeRecord({ tenantId: 't1', timestamp: new Date('2026-01-10T15:00:00Z') }),
        makeRecord({ tenantId: 't1', timestamp: new Date('2026-01-11T10:00:00Z') }),
      ]);
      const results = await store.aggregate(
        't1',
        { from: new Date('2026-01-01'), to: new Date('2026-12-31') },
        'day',
      );
      expect(results).toHaveLength(2);
    });
  });

  // ── deleteOlderThan ────────────────────────────────────────────────────────

  describe('deleteOlderThan()', () => {
    it('deletes records older than the cutoff date', async () => {
      await store.writeBatch([
        makeRecord({ timestamp: new Date('2026-01-01') }),
        makeRecord({ timestamp: new Date('2026-06-01') }),
      ]);
      const count = await store.deleteOlderThan(new Date('2026-03-01'));
      expect(count).toBe(1);
      expect(store.recordCount).toBe(1);
    });

    it('scopes deletion to a specific tenant', async () => {
      await store.writeBatch([
        makeRecord({ tenantId: 'a', timestamp: new Date('2026-01-01') }),
        makeRecord({ tenantId: 'b', timestamp: new Date('2026-01-01') }),
      ]);
      const count = await store.deleteOlderThan(new Date('2026-06-01'), 'a');
      expect(count).toBe(1);
      expect(store.recordCount).toBe(1);
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────────────

  describe('healthCheck()', () => {
    it('always returns true', async () => {
      expect(await store.healthCheck()).toBe(true);
    });
  });
});
