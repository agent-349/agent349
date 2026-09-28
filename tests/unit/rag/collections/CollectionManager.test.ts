import { describe, it, expect } from 'vitest';
import { CollectionManager } from '../../../../src/rag/collections/CollectionManager.js';
import { InMemoryVectorStore } from '../../../../src/rag/vectorstore/InMemoryVectorStore.js';
import { SDKError } from '../../../../src/errors/index.js';

function makeManager() {
  const store = new InMemoryVectorStore();
  const manager = new CollectionManager(store);
  return { manager, store };
}

const config = {
  dimensions: 4,
  distanceMetric: 'cosine' as const,
  embeddingProvider: 'mock',
  embeddingModel: 'mock-v1',
};

describe('CollectionManager', () => {
  it('creates a collection and lists it', async () => {
    const { manager } = makeManager();
    await manager.create('policies', config);
    const list = await manager.list();
    expect(list.find((c) => c.name === 'policies')).toBeDefined();
  });

  it('info returns correct metadata', async () => {
    const { manager } = makeManager();
    await manager.create('docs', config);
    const info = await manager.info('docs');
    expect(info.name).toBe('docs');
    expect(info.embeddingProvider).toBe('mock');
    expect(info.dimensions).toBe(4);
    expect(info.createdAt).toBeInstanceOf(Date);
  });

  it('throws SDKError when collection not tracked', async () => {
    const { manager } = makeManager();
    await expect(manager.info('unknown')).rejects.toThrow(SDKError);
  });

  it('exists returns true for created collection', async () => {
    const { manager } = makeManager();
    await manager.create('exists-col', config);
    expect(await manager.exists('exists-col')).toBe(true);
  });

  it('exists returns false for non-existent collection', async () => {
    const { manager } = makeManager();
    expect(await manager.exists('non-existent')).toBe(false);
  });

  it('delete removes from list', async () => {
    const { manager } = makeManager();
    await manager.create('to-delete', config);
    await manager.delete('to-delete');
    const list = await manager.list();
    expect(list.find((c) => c.name === 'to-delete')).toBeUndefined();
  });

  it('delete also removes the collection and its data from the underlying store', async () => {
    const { manager, store } = makeManager();
    await manager.create('to-delete-data', config);
    await store.upsert('to-delete-data', [
      { id: 'x', content: 'hello', vector: [1, 0, 0, 0], metadata: { documentId: 'x' } },
    ]);
    await manager.delete('to-delete-data');
    expect(await store.collectionExists('to-delete-data')).toBe(false);
  });

  it('delete is a no-op when the collection does not exist in the store', async () => {
    const { manager } = makeManager();
    await expect(manager.delete('never-created')).resolves.toBeUndefined();
  });

  it('recordIngest updates documentCount', async () => {
    const { manager } = makeManager();
    await manager.create('tracked', config);
    manager.recordIngest('tracked', 5);
    const info = await manager.info('tracked');
    expect(info.documentCount).toBe(1);
    expect(info.chunkCount).toBeGreaterThanOrEqual(0);
  });
});
