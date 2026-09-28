import type { LLMMessage } from '../types/index.js';

/**
 * Abstract coordinator for the SDK's 3-level memory system.
 *
 * Concrete implementations wire together a session store (Level 1),
 * a long-term store (Level 2), and an optional compression strategy.
 * The {@link AgentLoop} calls only {@link load}, {@link save}, and
 * {@link compress} — all higher-level persistence details are hidden behind
 * this interface.
 *
 * @example
 * ```typescript
 * class InMemoryMemoryManager extends MemoryManager {
 *   async load(sessionId) { return this.store.get(sessionId) ?? []; }
 *   async save(sessionId, messages) { this.store.set(sessionId, messages); }
 *   async compress(sessionId) { ... }
 * }
 * ```
 */
export abstract class MemoryManager {
  /**
   * Loads the full conversation history for the given session.
   *
   * @param sessionId - Session whose messages should be loaded.
   * @returns Ordered list of messages (oldest first). Empty array if no history.
   */
  abstract load(sessionId: string): Promise<LLMMessage[]>;

  /**
   * Persists the current conversation history for the given session.
   *
   * @param sessionId - Session to persist.
   * @param messages  - Full ordered message history to store.
   */
  abstract save(sessionId: string, messages: LLMMessage[]): Promise<void>;

  /**
   * Compresses the conversation history (e.g. sliding-window trim or
   * incremental summary via LLM). Called automatically when the history
   * exceeds the configured threshold.
   *
   * @param sessionId - Session whose history should be compressed.
   */
  abstract compress(sessionId: string): Promise<void>;
}
