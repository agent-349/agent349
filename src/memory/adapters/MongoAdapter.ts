import type { MongoClient, Collection } from 'mongodb';
import { StorageAdapter } from './StorageAdapter.js';
import type { MongoBackendConfig } from '../../config/ConfigLoader.js';

/** Internal document shape stored in MongoDB. */
interface KVDocument {
  _id: string;
  value: unknown;
  expiresAt?: Date;
  [key: string]: unknown;
}

/**
 * {@link StorageAdapter} backed by MongoDB via the official `mongodb` driver.
 *
 * Each adapter instance maps to **one collection** in one database. Use
 * separate adapter instances (with different `collection` values in the config)
 * for different storage layers so that each layer has clean schema boundaries.
 *
 * ### Document schema
 * ```
 * { _id: <key>, value: <any BSON>, expiresAt?: Date }
 * ```
 *
 * A TTL index is created on `expiresAt` (or the configured `ttlField`) during
 * {@link create}, enabling MongoDB to automatically expire documents at the
 * database level — exactly like `SET key value EX <ttl>` in Redis.
 *
 * ### Date handling
 * MongoDB preserves `Date` values natively. Consumers that already normalise
 * `Date` fields (e.g. `SessionManager`, `TokenTracker`) work without changes.
 *
 * @example
 * ```typescript
 * const adapter = await MongoAdapter.create({
 *   type: 'mongo',
 *   uri: 'mongodb://localhost:27017',
 *   database: 'agent349',
 *   collection: 'session_messages',
 * });
 * ```
 */
export class MongoAdapter extends StorageAdapter {
  override readonly name = 'mongo';
  readonly #client: MongoClient;
  readonly #collection: Collection<KVDocument>;
  readonly #ttlField: string;
  #closed = false;

  private constructor(client: MongoClient, collection: Collection<KVDocument>, ttlField: string) {
    super();
    this.#client = client;
    this.#collection = collection;
    this.#ttlField = ttlField;
  }

  /**
   * Creates a `MongoAdapter` from a {@link MongoBackendConfig}.
   *
   * Connects to MongoDB, ensures the TTL index exists, then returns the adapter.
   *
   * @throws If `mongodb` is not installed or the connection fails.
   */
  static async create(config: MongoBackendConfig): Promise<MongoAdapter> {
    const { MongoClient } = await import('mongodb');

    const client = new MongoClient(config.uri);
    await client.connect();

    const db = client.db(config.database);
    const collection = db.collection<KVDocument>(config.collection);
    const ttlField = config.ttlField ?? 'expiresAt';

    // Idempotent TTL index — MongoDB ignores it if it already exists with the same spec.
    await collection.createIndex(
      { [ttlField]: 1 },
      { expireAfterSeconds: 0, sparse: true, background: true },
    );

    return new MongoAdapter(client, collection, ttlField);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // StorageAdapter implementation
  // ─────────────────────────────────────────────────────────────────────────

  override async get(key: string): Promise<unknown> {
    const doc = await this.#collection.findOne({ _id: key } as unknown as Partial<KVDocument>);
    if (doc === null) return null;
    return doc.value;
  }

  override async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const doc: KVDocument = { _id: key, value };
    if (ttl !== undefined) {
      doc[this.#ttlField] = new Date(Date.now() + ttl * 1000);
    }
    await this.#collection.replaceOne({ _id: key } as unknown as Partial<KVDocument>, doc, {
      upsert: true,
    });
  }

  override async delete(key: string): Promise<void> {
    await this.#collection.deleteOne({ _id: key } as unknown as Partial<KVDocument>);
  }

  override async exists(key: string): Promise<boolean> {
    const count = await this.#collection.countDocuments(
      { _id: key } as unknown as Partial<KVDocument>,
      { limit: 1 },
    );
    return count > 0;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }
}
