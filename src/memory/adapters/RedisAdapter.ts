import type { Redis, RedisOptions } from 'ioredis';
import { StorageAdapter } from './StorageAdapter.js';
import type { RedisBackendConfig } from '../../config/ConfigLoader.js';

/**
 * {@link StorageAdapter} backed by Redis via `ioredis`.
 *
 * All values are JSON-serialised before writing and JSON-parsed on read, so
 * consumers that normalise `Date` fields (e.g. `SessionManager`,
 * `TokenTracker`) continue to work without modification.
 *
 * ### Key namespacing
 * An optional `keyPrefix` is prepended to every key, allowing multiple
 * adapter instances (or layers) to share a single Redis instance without
 * key collisions.
 *
 * ### Connection lifecycle
 * The underlying ioredis client uses lazy connect by default; the first
 * command triggers the TCP handshake. Call {@link close} to disconnect when
 * the adapter is no longer needed. `close()` is idempotent.
 *
 * @example
 * ```typescript
 * const adapter = await RedisAdapter.create({
 *   type: 'redis',
 *   host: 'redis.prod',
 *   port: 6380,
 *   password: process.env.REDIS_PASSWORD,
 *   keyPrefix: 'agent349:sess:',
 *   tls: true,
 * });
 * ```
 */
export class RedisAdapter extends StorageAdapter {
  override readonly name = 'redis';
  readonly #client: Redis;
  readonly #keyPrefix: string;
  #closed = false;

  private constructor(client: Redis, keyPrefix: string) {
    super();
    this.#client = client;
    this.#keyPrefix = keyPrefix;
  }

  /**
   * Creates a `RedisAdapter` from a {@link RedisBackendConfig}.
   *
   * Dynamically imports `ioredis` so that projects that do not use Redis
   * are not forced to install it.
   *
   * @throws If `ioredis` is not installed.
   */
  static async create(config: RedisBackendConfig): Promise<RedisAdapter> {
    const { Redis: IORedis } = await import('ioredis');

    const options: RedisOptions = {
      host: config.host ?? 'localhost',
      port: config.port ?? 6379,
      db: config.db ?? 0,
      lazyConnect: true,
      connectTimeout: config.connectTimeout ?? 5000,
      maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    };

    if (config.username) options.username = config.username;
    if (config.password) options.password = config.password;
    if (config.tls) options.tls = {};

    let client: Redis;
    if (config.url) {
      client = new IORedis(config.url, options);
    } else {
      client = new IORedis(options);
    }

    return new RedisAdapter(client, config.keyPrefix ?? '');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // StorageAdapter implementation
  // ─────────────────────────────────────────────────────────────────────────

  override async get(key: string): Promise<unknown> {
    const raw = await this.#client.get(this.#prefixed(key));
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  }

  override async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const serialised = JSON.stringify(value);
    if (ttl !== undefined) {
      await this.#client.set(this.#prefixed(key), serialised, 'EX', ttl);
    } else {
      await this.#client.set(this.#prefixed(key), serialised);
    }
  }

  override async delete(key: string): Promise<void> {
    await this.#client.del(this.#prefixed(key));
  }

  override async exists(key: string): Promise<boolean> {
    const count = await this.#client.exists(this.#prefixed(key));
    return count > 0;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.quit();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #prefixed(key: string): string {
    return this.#keyPrefix + key;
  }
}
