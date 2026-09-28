import type { LLMMessage } from '../types/index.js';
import type { StorageAdapter } from './adapters/StorageAdapter.js';
import { MemoryManager } from './MemoryManager.js';
import { SessionMemory } from './SessionMemory.js';
import type { MediaPersistence, OmittedMedia } from './mediaPersistence.js';
import { LongTermMemory } from './LongTermMemory.js';
import type { MemoryStrategy } from './strategies/MemoryStrategy.js';

/**
 * Configuration accepted by {@link DefaultMemoryManager}.
 */
export interface DefaultMemoryManagerConfig {
  /**
   * Time-to-live for session conversation histories, in seconds.
   * @default 3600 (1 hour)
   */
  sessionTtlSeconds?: number;
  /**
   * Maximum number of long-term facts stored per user.
   * @default 50
   */
  maxFactsPerUser?: number;
  /**
   * What happens to binary content (images, documents) when a conversation is
   * written to the session store.
   * @default 'omit'
   */
  mediaPersistence?: MediaPersistence;
  /**
   * Called when media is omitted while persisting, so the owning layer can
   * surface it on the EventBus.
   */
  onMediaOmitted?: (sessionId: string, omitted: OmittedMedia[]) => void;
}

/**
 * Concrete implementation of the SDK's 3-level memory system.
 *
 * Coordinates:
 * - **Level 1** — {@link SessionMemory}: active conversation history (short-lived, TTL-based).
 * - **Level 2** — {@link LongTermMemory}: persistent user facts (cross-session knowledge).
 * - **Strategy** — Plugable {@link MemoryStrategy} ({@link SlidingWindow} or
 *   {@link IncrementalSummary}) that compresses the history when it grows too long.
 *
 * ### Automatic compression
 * After every `save()`, the history length is checked against the strategy's
 * threshold. If compression is warranted, `compress()` is invoked automatically
 * so the stored history is always within the configured bounds.
 *
 * @example
 * ```typescript
 * const manager = new DefaultMemoryManager(
 *   new InMemoryAdapter(),
 *   new InMemoryAdapter(),
 *   new SlidingWindow({ maxMessages: 20 }),
 * );
 *
 * await manager.save('sess-1', messages);
 * const loaded = await manager.load('sess-1');
 * ```
 */
export class DefaultMemoryManager extends MemoryManager {
  readonly #sessionMemory: SessionMemory;
  readonly #longTermMemory: LongTermMemory;
  readonly #strategy: MemoryStrategy;

  /**
   * @param sessionStore  - Adapter for Level-1 (session) persistence.
   * @param longTermStore - Adapter for Level-2 (long-term) persistence.
   * @param strategy      - Compression strategy.
   * @param config        - Optional tuning parameters.
   */
  constructor(
    sessionStore: StorageAdapter,
    longTermStore: StorageAdapter,
    strategy: MemoryStrategy,
    config: DefaultMemoryManagerConfig = {},
  ) {
    super();
    this.#sessionMemory = new SessionMemory(sessionStore, {
      ...(config.sessionTtlSeconds !== undefined && { ttlSeconds: config.sessionTtlSeconds }),
      ...(config.mediaPersistence !== undefined && {
        mediaPersistence: config.mediaPersistence,
      }),
      ...(config.onMediaOmitted !== undefined && { onMediaOmitted: config.onMediaOmitted }),
    });
    this.#longTermMemory = new LongTermMemory(longTermStore, {
      ...(config.maxFactsPerUser !== undefined && { maxFactsPerUser: config.maxFactsPerUser }),
    });
    this.#strategy = strategy;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MemoryManager implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Loads the conversation history for `sessionId` from Level-1 storage.
   *
   * @param sessionId - Session to load.
   * @returns Ordered message list. Empty array when no history exists.
   */
  override async load(sessionId: string): Promise<LLMMessage[]> {
    return this.#sessionMemory.load(sessionId);
  }

  /**
   * Persists the conversation history to Level-1 storage.
   *
   * After saving, checks whether the strategy's compression threshold is
   * reached. If so, {@link compress} is called automatically to trim the
   * stored history.
   *
   * @param sessionId - Session to save.
   * @param messages  - Full ordered message history.
   */
  override async save(sessionId: string, messages: LLMMessage[]): Promise<void> {
    await this.#sessionMemory.save(sessionId, messages);
    if (this.#strategy.shouldCompress(messages)) {
      await this.compress(sessionId);
    }
  }

  /**
   * Compresses the stored history for `sessionId` using the configured strategy.
   *
   * Loads the current history, applies the strategy, and saves the result.
   * No-op if the session has no history.
   *
   * @param sessionId - Session whose history to compress.
   */
  override async compress(sessionId: string): Promise<void> {
    const messages = await this.#sessionMemory.load(sessionId);
    if (messages.length === 0) return;
    const compressed = await this.#strategy.compress(messages);
    await this.#sessionMemory.save(sessionId, compressed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Level-2 API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves all Level-2 facts for the given user.
   *
   * @param tenantId - Tenant the user belongs to.
   * @param userId   - User whose facts to retrieve.
   * @returns Ordered list of fact strings. Empty array if none.
   */
  async getLongTermContext(tenantId: string, userId: string): Promise<string[]> {
    return this.#longTermMemory.getFacts(tenantId, userId);
  }

  /**
   * Appends a new Level-2 fact for the given user.
   *
   * @param tenantId - Tenant the user belongs to.
   * @param userId   - User this fact belongs to.
   * @param fact     - The fact string to persist.
   */
  async saveLongTermFact(tenantId: string, userId: string, fact: string): Promise<void> {
    return this.#longTermMemory.saveFact(tenantId, userId, fact);
  }
}
