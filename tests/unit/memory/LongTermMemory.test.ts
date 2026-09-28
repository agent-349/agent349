import { describe, it, expect, beforeEach } from 'vitest';
import { LongTermMemory } from '../../../src/memory/LongTermMemory.js';
import { InMemoryAdapter } from '../../../src/memory/adapters/InMemoryAdapter.js';

describe('LongTermMemory', () => {
  let store: InMemoryAdapter;
  let ltm: LongTermMemory;

  beforeEach(() => {
    store = new InMemoryAdapter();
    ltm = new LongTermMemory(store);
  });

  describe('getFacts()', () => {
    it('returns empty array when no facts stored', async () => {
      expect(await ltm.getFacts('acme', 'u1')).toEqual([]);
    });

    it('returns saved facts in insertion order', async () => {
      await ltm.saveFact('acme', 'u1', 'Speaks Spanish.');
      await ltm.saveFact('acme', 'u1', 'Works in Finance.');
      expect(await ltm.getFacts('acme', 'u1')).toEqual(['Speaks Spanish.', 'Works in Finance.']);
    });
  });

  describe('saveFact()', () => {
    it('appends new facts to the existing list', async () => {
      await ltm.saveFact('t1', 'u1', 'fact A');
      await ltm.saveFact('t1', 'u1', 'fact B');
      await ltm.saveFact('t1', 'u1', 'fact C');

      expect(await ltm.getFacts('t1', 'u1')).toHaveLength(3);
    });

    it('stores under per-tenant, per-user isolation', async () => {
      await ltm.saveFact('acme', 'u1', 'fact for acme/u1');
      await ltm.saveFact('acme', 'u2', 'fact for acme/u2');
      await ltm.saveFact('other', 'u1', 'fact for other/u1');

      expect(await ltm.getFacts('acme', 'u1')).toEqual(['fact for acme/u1']);
      expect(await ltm.getFacts('acme', 'u2')).toEqual(['fact for acme/u2']);
      expect(await ltm.getFacts('other', 'u1')).toEqual(['fact for other/u1']);
    });

    it('stores under expected key format', async () => {
      await ltm.saveFact('acme', 'u99', 'any');
      expect(await store.exists('ltm:facts:acme:u99')).toBe(true);
    });

    it('evicts oldest fact when maxFactsPerUser is reached', async () => {
      const smallLtm = new LongTermMemory(store, { maxFactsPerUser: 3 });
      await smallLtm.saveFact('t', 'u', 'oldest');
      await smallLtm.saveFact('t', 'u', 'middle');
      await smallLtm.saveFact('t', 'u', 'newest');

      // Adding a 4th evicts the oldest
      await smallLtm.saveFact('t', 'u', 'extra');

      const facts = await smallLtm.getFacts('t', 'u');
      expect(facts).toHaveLength(3);
      expect(facts).not.toContain('oldest');
      expect(facts).toContain('extra');
    });

    it('default maxFactsPerUser allows 50 facts', async () => {
      for (let i = 0; i < 50; i++) {
        await ltm.saveFact('t', 'u', `fact ${i}`);
      }
      expect(await ltm.getFacts('t', 'u')).toHaveLength(50);
    });

    it('drops oldest when 51st fact is added', async () => {
      for (let i = 0; i < 50; i++) {
        await ltm.saveFact('t', 'u', `fact ${i}`);
      }
      await ltm.saveFact('t', 'u', 'fact 50');

      const facts = await ltm.getFacts('t', 'u');
      expect(facts).toHaveLength(50);
      expect(facts[0]).toBe('fact 1');
    });
  });

  describe('clearFacts()', () => {
    it('removes all facts for the user', async () => {
      await ltm.saveFact('t', 'u', 'a fact');
      await ltm.clearFacts('t', 'u');
      expect(await ltm.getFacts('t', 'u')).toEqual([]);
    });

    it('no-op for a user with no facts', async () => {
      await expect(ltm.clearFacts('t', 'nobody')).resolves.toBeUndefined();
    });

    it('does not affect other users', async () => {
      await ltm.saveFact('t', 'u1', 'keep me');
      await ltm.saveFact('t', 'u2', 'clear me');

      await ltm.clearFacts('t', 'u2');

      expect(await ltm.getFacts('t', 'u1')).toEqual(['keep me']);
    });
  });
});
