import { StorageAdapter } from './StorageAdapter.js';

/**
 * In-memory storage adapter backed by a plain `Map`.
 *
 * Intended for **unit testing and local development** — data is not persisted
 * across process restarts. Supports per-key TTL via `setTimeout`; timers are
 * automatically cleared on overwrite, deletion, or {@link clear}.
 *
 * @example
 * ```typescript
 * const store = new InMemoryAdapter();
 *
 * await store.set('session:abc', messages, 3600); // expires in 1 h
 * const data = await store.get('session:abc');    // → messages
 * await store.delete('session:abc');
 * ```
 */
export class InMemoryAdapter extends StorageAdapter {
  override readonly name = 'memory';

  /** Stored values, keyed by storage key. */
  readonly #store = new Map<string, unknown>();

  /**
   * Active TTL timers.
   * When a timer fires it removes the corresponding key from `#store`.
   */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  // ─────────────────────────────────────────────────────────────────────────
  // StorageAdapter implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the stored value for `key`, or `null` if absent or expired.
   */
  override async get(key: string): Promise<unknown> {
    return this.#store.has(key) ? (this.#store.get(key) ?? null) : null;
  }

  /**
   * Stores `value` under `key`.
   * If `ttl` (in seconds) is provided, the entry is automatically deleted
   * after that many seconds. Any previous TTL timer for the key is cancelled.
   */
  override async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.#clearTimer(key);
    this.#store.set(key, value);

    if (ttl !== undefined) {
      const timer = setTimeout(() => {
        this.#store.delete(key);
        this.#timers.delete(key);
      }, ttl * 1000);

      // Allow Node.js to exit even if this timer is still pending.
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }

      this.#timers.set(key, timer);
    }
  }

  /**
   * Removes `key` from the store and cancels any active TTL timer.
   * No-op if the key does not exist.
   */
  override async delete(key: string): Promise<void> {
    this.#clearTimer(key);
    this.#store.delete(key);
  }

  /**
   * Returns `true` if `key` exists and has not expired, `false` otherwise.
   */
  override async exists(key: string): Promise<boolean> {
    return this.#store.has(key);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Removes **all** entries and cancels all pending TTL timers.
   * Useful in test `afterEach` hooks to reset state between tests.
   */
  clear(): void {
    for (const key of this.#timers.keys()) {
      this.#clearTimer(key);
    }
    this.#store.clear();
  }

  /**
   * Returns the number of live entries currently in the store.
   * Useful for assertions in tests.
   */
  get size(): number {
    return this.#store.size;
  }

  /** No-op: no external connections to release. */
  override async close(): Promise<void> {
    // intentional no-op
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #clearTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
  }
}
