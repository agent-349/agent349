import type { LLMMessage } from '../types/index.js';
import type { StorageAdapter } from './adapters/StorageAdapter.js';
import { applyMediaPersistence } from './mediaPersistence.js';
import type { MediaPersistence, OmittedMedia } from './mediaPersistence.js';

/**
 * Configuration accepted by {@link SessionMemory}.
 */
export interface SessionMemoryConfig {
  /**
   * Time-to-live for stored session histories, in seconds.
   * Each `save()` call resets the TTL.
   * @default 3600 (1 hour)
   */
  ttlSeconds?: number;
  /**
   * What happens to binary content when the history is written.
   *
   * Defaults to `'omit'`: inline images and documents are replaced by an
   * explicit placeholder rather than pushed into Redis or MongoDB, while
   * provider file references are kept. See {@link MediaPersistence}.
   */
  mediaPersistence?: MediaPersistence;
  /**
   * Called once per omitted block, so the omission can be surfaced on the
   * EventBus by the layer that owns it. Keeps this class free of the bus.
   */
  onMediaOmitted?: (sessionId: string, omitted: OmittedMedia[]) => void;
}

/**
 * Level-1 memory: active conversation history for a single session.
 *
 * Stores and retrieves the ordered list of {@link LLMMessage}s that constitute
 * the conversation up to the current point. Each session is isolated by its
 * `sessionId`; messages are automatically expired after `ttlSeconds` of
 * inactivity.
 *
 * Storage key format: `session:messages:{sessionId}`
 *
 * @example
 * ```typescript
 * const sessionMemory = new SessionMemory(new InMemoryAdapter(), { ttlSeconds: 1800 });
 *
 * await sessionMemory.save('sess-123', messages);
 * const loaded = await sessionMemory.load('sess-123');
 * ```
 */
export class SessionMemory {
  readonly #store: StorageAdapter;
  readonly #ttlSeconds: number;
  readonly #mediaPersistence: MediaPersistence;
  readonly #onMediaOmitted: ((sessionId: string, omitted: OmittedMedia[]) => void) | undefined;

  /**
   * @param store  - Storage adapter for message persistence.
   * @param config - Configuration; TTL defaults to 3600 s.
   */
  constructor(store: StorageAdapter, config: SessionMemoryConfig = {}) {
    this.#store = store;
    this.#ttlSeconds = config.ttlSeconds ?? 3600;
    this.#mediaPersistence = config.mediaPersistence ?? 'omit';
    this.#onMediaOmitted = config.onMediaOmitted;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Loads the conversation history for `sessionId`.
   *
   * @param sessionId - The session to load.
   * @returns Ordered message list (oldest first). Empty array if no history found.
   */
  async load(sessionId: string): Promise<LLMMessage[]> {
    const raw = await this.#store.get(this.#key(sessionId));
    if (!Array.isArray(raw)) return [];
    return raw as LLMMessage[];
  }

  /**
   * Persists the conversation history for `sessionId`, resetting the TTL.
   *
   * **Concurrency note:** this method performs a full overwrite (not an atomic
   * append). Two concurrent writes to the same `sessionId` will race — the
   * last writer wins and earlier writes may be lost. Callers must ensure that
   * requests sharing a session are processed sequentially (e.g. session
   * stickiness at the load-balancer level, or a per-session queue). Adapters
   * that expose atomic compare-and-swap semantics can override this behaviour.
   *
   * @param sessionId - The session to save.
   * @param messages  - Full ordered message history to persist.
   */
  async save(sessionId: string, messages: LLMMessage[]): Promise<void> {
    const { messages: toStore, omitted } = applyMediaPersistence(messages, this.#mediaPersistence);
    if (omitted.length > 0) this.#onMediaOmitted?.(sessionId, omitted);
    await this.#store.set(this.#key(sessionId), toStore, this.#ttlSeconds);
  }

  /**
   * Removes the conversation history for `sessionId`.
   * No-op if the session does not exist.
   *
   * @param sessionId - The session to clear.
   */
  async clear(sessionId: string): Promise<void> {
    await this.#store.delete(this.#key(sessionId));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #key(sessionId: string): string {
    return `session:messages:${sessionId}`;
  }
}
