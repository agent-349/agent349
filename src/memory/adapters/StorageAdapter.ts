/**
 * Abstract base class for all storage adapters in the SDK.
 *
 * Concrete implementations (Redis, Mongo, InMemory) extend this class and
 * provide the underlying persistence mechanism. All methods are async so that
 * any network-backed store fits the same contract without blocking the event loop.
 *
 * ### Implementing a custom adapter
 * ```typescript
 * export class MyAdapter extends StorageAdapter {
 *   readonly name = 'my-store';
 *
 *   async get(key: string): Promise<unknown> { ... }
 *   async set(key: string, value: unknown, ttl?: number): Promise<void> { ... }
 *   async delete(key: string): Promise<void> { ... }
 *   async exists(key: string): Promise<boolean> { ... }
 * }
 * ```
 */
export abstract class StorageAdapter {
  /** Human-readable identifier for this adapter (e.g. `'redis'`, `'memory'`). */
  abstract readonly name: string;

  /**
   * Retrieves the value stored under `key`.
   *
   * @param key - The storage key.
   * @returns The stored value, or `null` if the key does not exist or has expired.
   */
  abstract get(key: string): Promise<unknown>;

  /**
   * Stores `value` under `key`, optionally expiring after `ttl` seconds.
   *
   * If a value already exists for `key`, it is replaced and any active TTL
   * timer is reset.
   *
   * @param key   - The storage key.
   * @param value - The value to store (must be serialisable).
   * @param ttl   - Time-to-live in **seconds**. Omit for no expiry.
   */
  abstract set(key: string, value: unknown, ttl?: number): Promise<void>;

  /**
   * Removes the entry for `key`. No-op if the key does not exist.
   *
   * @param key - The storage key to remove.
   */
  abstract delete(key: string): Promise<void>;

  /**
   * Checks whether `key` exists (and has not expired).
   *
   * @param key - The storage key.
   * @returns `true` if the key is present and live, `false` otherwise.
   */
  abstract exists(key: string): Promise<boolean>;

  /**
   * Releases any underlying resources (connections, file handles, timers).
   *
   * Must be idempotent — calling `close()` more than once must not throw.
   * Called by {@link Orchestrator.shutdown} when tearing down the runtime.
   */
  abstract close(): Promise<void>;
}
