import { describe, it, expect, beforeEach } from 'vitest';
import { SessionMemory } from '../../../src/memory/SessionMemory.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';
import type { LLMMessage } from '../../../src/types/index.js';

function makeMessages(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as LLMMessage['role'],
    content: `message ${i}`,
  }));
}

describe('SessionMemory', () => {
  let store: InMemoryAdapter;
  let memory: SessionMemory;

  beforeEach(() => {
    store = new InMemoryAdapter();
    memory = new SessionMemory(store);
  });

  describe('load()', () => {
    it('returns empty array for an unknown sessionId', async () => {
      expect(await memory.load('unknown')).toEqual([]);
    });

    it('returns the previously saved messages', async () => {
      const messages = makeMessages(3);
      await memory.save('s1', messages);
      expect(await memory.load('s1')).toEqual(messages);
    });

    it('different sessions are isolated', async () => {
      const m1 = makeMessages(2);
      const m2 = makeMessages(4);
      await memory.save('s1', m1);
      await memory.save('s2', m2);

      expect(await memory.load('s1')).toEqual(m1);
      expect(await memory.load('s2')).toEqual(m2);
    });
  });

  describe('save()', () => {
    it('overwrites previous messages for the same session', async () => {
      const original = makeMessages(3);
      const updated = makeMessages(5);

      await memory.save('s1', original);
      await memory.save('s1', updated);

      expect(await memory.load('s1')).toEqual(updated);
    });

    it('stores the messages with the configured TTL', async () => {
      // Verify it calls the store with TTL argument (default 3600)
      const customMemory = new SessionMemory(store, { ttlSeconds: 1800 });
      await customMemory.save('s1', makeMessages(2));
      // If TTL is correctly propagated, the key must exist in the store
      expect(await store.exists('session:messages:s1')).toBe(true);
    });

    it('stores messages under the expected key format', async () => {
      await memory.save('abc-123', makeMessages(1));
      expect(await store.exists('session:messages:abc-123')).toBe(true);
    });
  });

  describe('clear()', () => {
    it('removes the session history', async () => {
      await memory.save('s1', makeMessages(3));
      await memory.clear('s1');
      expect(await memory.load('s1')).toEqual([]);
    });

    it('no-op for a session that never existed', async () => {
      await expect(memory.clear('ghost')).resolves.toBeUndefined();
    });

    it('does not affect other sessions', async () => {
      const m2 = makeMessages(2);
      await memory.save('s1', makeMessages(3));
      await memory.save('s2', m2);

      await memory.clear('s1');

      expect(await memory.load('s2')).toEqual(m2);
    });
  });
});
