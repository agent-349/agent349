import type { StorageAdapter } from './StorageAdapter.js';

/**
 * Registry of pre-built {@link StorageAdapter} instances, keyed by backend name.
 *
 * Pass a `StorageRegistry` to {@link Orchestrator.fromConfig} to provide
 * adapters that were constructed programmatically (e.g. with custom
 * ioredis/MongoClient configuration, sentinel setup, or test doubles).
 *
 * @example
 * ```typescript
 * const registry = new StorageRegistry();
 * registry.register('main-redis', new RedisAdapter({ type: 'redis', host: 'redis.prod' }));
 *
 * const orch = await Orchestrator.fromConfig(config, { storageRegistry: registry });
 * ```
 */
export class StorageRegistry {
  readonly #adapters = new Map<string, StorageAdapter>();

  /**
   * Registers an adapter under `name`. If a different adapter was already
   * registered under the same name it is replaced.
   *
   * @param name    - Backend name as referenced in `storage.backends`.
   * @param adapter - Pre-built adapter instance.
   * @returns `this` for chaining.
   */
  register(name: string, adapter: StorageAdapter): this {
    this.#adapters.set(name, adapter);
    return this;
  }

  /**
   * Returns the adapter registered under `name`, or `undefined` if none.
   *
   * @param name - Backend name to look up.
   */
  get(name: string): StorageAdapter | undefined {
    return this.#adapters.get(name);
  }

  /** Returns `true` if a adapter is registered under `name`. */
  has(name: string): boolean {
    return this.#adapters.has(name);
  }
}
