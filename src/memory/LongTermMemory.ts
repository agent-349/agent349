import type { StorageAdapter } from './adapters/StorageAdapter.js';

/**
 * Configuration accepted by {@link LongTermMemory}.
 */
export interface LongTermMemoryConfig {
  /**
   * Maximum number of facts stored per user.
   * When this limit is reached, the oldest fact is dropped before inserting
   * the new one (FIFO eviction).
   * @default 50
   */
  maxFactsPerUser?: number;
}

/**
 * Level-2 memory: persistent user facts that survive across sessions.
 *
 * Unlike the session history (Level 1), which stores raw message turns,
 * Level-2 memory stores distilled, human-readable facts about a user —
 * e.g. "belongs to the Finance department", "prefers short answers",
 * "last queried account 1001".
 *
 * Facts are stored as a flat string array under a per-user key so they can
 * be injected into the agent's system prompt or context without replaying the
 * full conversation history.
 *
 * Storage key format: `ltm:facts:{tenantId}:{userId}`
 *
 * @example
 * ```typescript
 * const ltm = new LongTermMemory(new InMemoryAdapter());
 *
 * await ltm.saveFact('acme', 'u1', 'Prefers responses in Spanish.');
 * const facts = await ltm.getFacts('acme', 'u1');
 * // → ['Prefers responses in Spanish.']
 * ```
 */
export class LongTermMemory {
  readonly #store: StorageAdapter;
  readonly #maxFactsPerUser: number;

  /**
   * @param store  - Storage adapter for fact persistence.
   * @param config - Configuration; defaults to 50 facts per user.
   */
  constructor(store: StorageAdapter, config: LongTermMemoryConfig = {}) {
    this.#store = store;
    this.#maxFactsPerUser = config.maxFactsPerUser ?? 50;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all stored facts for the given user.
   *
   * @param tenantId - Tenant the user belongs to.
   * @param userId   - The user whose facts to retrieve.
   * @returns Ordered list of fact strings (oldest first). Empty array if none.
   */
  async getFacts(tenantId: string, userId: string): Promise<string[]> {
    const raw = await this.#store.get(this.#key(tenantId, userId));
    if (!Array.isArray(raw)) return [];
    return raw as string[];
  }

  /**
   * Appends a new fact for the given user.
   *
   * If the current fact count equals `maxFactsPerUser`, the oldest fact is
   * evicted (FIFO) before inserting the new one.
   *
   * @param tenantId - Tenant the user belongs to.
   * @param userId   - The user this fact belongs to.
   * @param fact     - The fact string to store.
   */
  async saveFact(tenantId: string, userId: string, fact: string): Promise<void> {
    const facts = await this.getFacts(tenantId, userId);
    facts.push(fact);

    // FIFO eviction when capacity is reached.
    while (facts.length > this.#maxFactsPerUser) {
      facts.shift();
    }

    await this.#store.set(this.#key(tenantId, userId), facts);
  }

  /**
   * Removes all facts for the given user.
   * No-op if no facts are stored.
   *
   * @param tenantId - Tenant the user belongs to.
   * @param userId   - The user whose facts to remove.
   */
  async clearFacts(tenantId: string, userId: string): Promise<void> {
    await this.#store.delete(this.#key(tenantId, userId));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #key(tenantId: string, userId: string): string {
    return `ltm:facts:${tenantId}:${userId}`;
  }
}
