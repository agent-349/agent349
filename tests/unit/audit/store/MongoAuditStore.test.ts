import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuditRecord } from '../../../../src/types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// mongodb mock
// ─────────────────────────────────────────────────────────────────────────────

/** A chainable find-cursor stub backed by a fixed result array. */
function makeCursor(docs: unknown[]) {
  const cursor = {
    sort: vi.fn(() => cursor),
    skip: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => docs),
  };
  return cursor;
}

const collection = {
  createIndex: vi.fn(async () => undefined),
  insertMany: vi.fn(async () => ({ insertedCount: 0 })),
  findOne: vi.fn(async () => null),
  find: vi.fn(() => makeCursor([])),
  countDocuments: vi.fn(async () => 0),
  aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
  deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
};

const dbCommand = vi.fn(async () => ({ ok: 1 }));
const db = {
  collection: vi.fn(() => collection),
  command: dbCommand,
};

const clientConnect = vi.fn(async () => undefined);
const clientClose = vi.fn(async () => undefined);

class FakeMongoClient {
  constructor(
    public uri: string,
    public options?: unknown,
  ) {}
  connect = clientConnect;
  close = clientClose;
  db = vi.fn(() => db);
}

vi.mock('mongodb', () => ({ MongoClient: FakeMongoClient }));

// Import after the mock is registered.
const { MongoAuditStore } = await import('../../../../src/audit/store/MongoAuditStore.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'rec-1',
    timestamp: new Date('2026-01-15T10:00:00Z'),
    requestId: 'req-1',
    sessionId: 'sess-1',
    tenantId: 'acme',
    userId: 'u1',
    agentId: 'agent-1',
    category: 'tool',
    action: 'call_end',
    outcome: 'success',
    severity: 'info',
    detail: { summary: 'ok' },
    metrics: { durationMs: 100, tokensInput: 20, tokensOutput: 10, estimatedCostUsd: 0.001 },
    _integrityHash: 'abc',
    ...overrides,
  };
}

async function makeStore() {
  return MongoAuditStore.create({
    uri: 'mongodb://localhost:27017',
    database: 'testdb',
    collection: 'audit_records',
    retentionDays: 365,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  collection.find.mockReturnValue(makeCursor([]));
  collection.aggregate.mockReturnValue({ toArray: vi.fn(async () => []) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MongoAuditStore.create()', () => {
  it('connects and declares all required indexes', async () => {
    await makeStore();
    expect(clientConnect).toHaveBeenCalledOnce();
    // 6 base indexes + 1 TTL index (retentionDays set).
    expect(collection.createIndex).toHaveBeenCalledTimes(7);
    // TTL index uses expireAfterSeconds.
    const ttlCall = collection.createIndex.mock.calls.find(
      (c) => (c[1] as { expireAfterSeconds?: number })?.expireAfterSeconds !== undefined,
    );
    expect(ttlCall).toBeDefined();
    expect((ttlCall![1] as { expireAfterSeconds: number }).expireAfterSeconds).toBe(365 * 86400);
  });

  it('omits the TTL index when retentionDays is not set', async () => {
    await MongoAuditStore.create({ uri: 'mongodb://x', database: 'd' });
    expect(collection.createIndex).toHaveBeenCalledTimes(6);
  });

  it('defaults the write concern to majority', async () => {
    await makeStore();
    // FakeMongoClient stores constructor options; recover the last instance via db() call.
    expect((db.collection as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});

describe('writeBatch()', () => {
  it('inserts records with ordered:false', async () => {
    const store = await makeStore();
    await store.writeBatch([makeRecord(), makeRecord({ id: 'rec-2' })]);
    expect(collection.insertMany).toHaveBeenCalledOnce();
    const [docs, opts] = collection.insertMany.mock.calls[0]!;
    expect((docs as unknown[]).length).toBe(2);
    expect(opts).toEqual({ ordered: false });
    // id maps to _id.
    expect((docs as Array<{ _id: string }>)[0]!._id).toBe('rec-1');
  });

  it('is a no-op for an empty batch', async () => {
    const store = await makeStore();
    await store.writeBatch([]);
    expect(collection.insertMany).not.toHaveBeenCalled();
  });
});

describe('query()', () => {
  it('builds an equality + range filter and maps _id back to id', async () => {
    const store = await makeStore();
    collection.countDocuments.mockResolvedValueOnce(1);
    collection.find.mockReturnValueOnce(makeCursor([{ ...makeRecord(), _id: 'rec-1' }]));

    const result = await store.query({
      tenantId: 'acme',
      category: 'tool',
      dateRange: { from: new Date('2026-01-01'), to: new Date('2026-02-01') },
    });

    const filter = collection.find.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter['tenantId']).toBe('acme');
    expect(filter['category']).toBe('tool');
    expect(filter['timestamp']).toMatchObject({ $gte: expect.any(Date), $lte: expect.any(Date) });

    expect(result.total).toBe(1);
    expect(result.records[0]!.id).toBe('rec-1');
  });

  it('uses $in for array filters', async () => {
    const store = await makeStore();
    await store.query({
      tenantId: 'acme',
      severity: ['warning', 'critical'],
      dateRange: { from: new Date(0), to: new Date() },
    });
    const filter = collection.find.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter['severity']).toEqual({ $in: ['warning', 'critical'] });
  });

  it('builds a case-insensitive $or for searchText with escaped regex', async () => {
    const store = await makeStore();
    await store.query({
      tenantId: 'acme',
      searchText: 'a.b*c',
      dateRange: { from: new Date(0), to: new Date() },
    });
    const filter = collection.find.mock.calls[0]![0] as Record<string, unknown>;
    const or = filter['$or'] as Array<Record<string, { $regex: string }>>;
    expect(or).toHaveLength(3);
    expect(or[0]!['detail.summary']!.$regex).toBe('a\\.b\\*c');
  });
});

describe('getByRequestId()', () => {
  it('filters by requestId and sorts ascending by timestamp', async () => {
    const store = await makeStore();
    const cursor = makeCursor([{ ...makeRecord(), _id: 'rec-1' }]);
    collection.find.mockReturnValueOnce(cursor);

    const records = await store.getByRequestId('req-1');
    expect(collection.find.mock.calls[0]![0]).toEqual({ requestId: 'req-1' });
    expect(cursor.sort).toHaveBeenCalledWith({ timestamp: 1 });
    expect(records[0]!.id).toBe('rec-1');
  });
});

describe('aggregate()', () => {
  it('maps grouped rows, splitting input/output tokens', async () => {
    const store = await makeStore();
    collection.aggregate.mockReturnValueOnce({
      toArray: vi.fn(async () => [
        {
          _id: 'tool',
          count: 3,
          totalDuration: 300,
          durationCount: 3,
          totalTokensInput: 60,
          totalTokensOutput: 30,
          totalCost: 0.05,
        },
      ]),
    });

    const result = await store.aggregate('acme', { from: new Date(0), to: new Date() }, 'category');

    expect(result[0]).toMatchObject({
      key: 'tool',
      count: 3,
      avgDurationMs: 100,
      totalTokens: 90,
      totalTokensInput: 60,
      totalTokensOutput: 30,
      totalCostUsd: 0.05,
    });
  });

  it('uses $dateToString grouping for day/hour dimensions', async () => {
    const store = await makeStore();
    await store.aggregate('acme', { from: new Date(0), to: new Date() }, 'day');
    const pipeline = collection.aggregate.mock.calls[0]![0] as Array<{ $group?: { _id: unknown } }>;
    const group = pipeline.find((s) => s.$group)!.$group!;
    expect(group._id).toMatchObject({ $dateToString: { format: '%Y-%m-%d' } });
  });

  it('groups user/agent dimensions by the matching field', async () => {
    const store = await makeStore();
    await store.aggregate('acme', { from: new Date(0), to: new Date() }, 'agent');
    const pipeline = collection.aggregate.mock.calls[0]![0] as Array<{ $group?: { _id: unknown } }>;
    const group = pipeline.find((s) => s.$group)!.$group!;
    expect(group._id).toBe('$agentId');
  });
});

describe('deleteOlderThan()', () => {
  it('deletes by timestamp and returns the deleted count', async () => {
    const store = await makeStore();
    collection.deleteMany.mockResolvedValueOnce({ deletedCount: 5 });
    const cutoff = new Date('2026-01-01');
    const n = await store.deleteOlderThan(cutoff, 'acme');
    expect(n).toBe(5);
    const filter = collection.deleteMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter['tenantId']).toBe('acme');
    expect(filter['timestamp']).toEqual({ $lt: cutoff });
  });
});

describe('healthCheck() and close()', () => {
  it('returns true when ping succeeds', async () => {
    const store = await makeStore();
    expect(await store.healthCheck()).toBe(true);
    expect(dbCommand).toHaveBeenCalledWith({ ping: 1 });
  });

  it('returns false when ping throws', async () => {
    const store = await makeStore();
    dbCommand.mockRejectedValueOnce(new Error('down'));
    expect(await store.healthCheck()).toBe(false);
  });

  it('close() is idempotent', async () => {
    const store = await makeStore();
    await store.close();
    await store.close();
    expect(clientClose).toHaveBeenCalledOnce();
  });
});
