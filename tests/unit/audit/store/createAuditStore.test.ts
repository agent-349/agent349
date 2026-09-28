import { describe, it, expect, vi } from 'vitest';
import { InMemoryAuditStore } from '../../../../src/audit/store/InMemoryAuditStore.js';

// Mock the Mongo store so the factory's mongo branch is testable without a real
// MongoDB connection.
const mongoCreate = vi.fn(async (config: unknown) => ({ name: 'mongo-audit', config }));
vi.mock('../../../../src/audit/store/MongoAuditStore.js', () => ({
  MongoAuditStore: { create: mongoCreate },
}));

const { createAuditStore } = await import('../../../../src/audit/store/createAuditStore.js');

describe('createAuditStore()', () => {
  it('returns an InMemoryAuditStore for the memory type', async () => {
    const store = await createAuditStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryAuditStore);
    expect(store.name).toBe('in-memory');
  });

  it('routes the mongo type to MongoAuditStore.create with the right config', async () => {
    await createAuditStore({
      type: 'mongo',
      uri: 'mongodb://localhost:27017',
      database: 'agent349',
      collection: 'audit_records',
      retentionDays: 365,
    });
    expect(mongoCreate).toHaveBeenCalledWith({
      uri: 'mongodb://localhost:27017',
      database: 'agent349',
      collection: 'audit_records',
      retentionDays: 365,
    });
  });

  it('omits optional fields it was not given', async () => {
    mongoCreate.mockClear();
    await createAuditStore({ type: 'mongo', uri: 'mongodb://x', database: 'd' });
    expect(mongoCreate).toHaveBeenCalledWith({ uri: 'mongodb://x', database: 'd' });
  });
});
