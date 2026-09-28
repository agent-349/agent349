import { ConnectionDriver } from '../../../connections/types.js';
import type { ConnectionConfig, MongoConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import { ConnectionError } from '../../../errors/index.js';

/** One read against a Mongo collection. */
export interface MongoQueryRequest {
  /** Collection to read. */
  collection: string;
  /** Filter document, for a find. */
  filter?: Record<string, unknown>;
  /** Aggregation stages, for a pipeline. Takes precedence over `filter`. */
  pipeline?: unknown[];
  /** Fields to return. */
  projection?: Record<string, unknown>;
  /** Sort specification. */
  sort?: Record<string, unknown>;
  /** Maximum documents. */
  limit: number;
  /** Server-side time cap, in milliseconds. */
  maxTimeMs: number;
}

/** What a Mongo read returned. */
export interface MongoQueryResult {
  rows: Record<string, unknown>[];
}

/** A {@link ConnectionDriver} that can read from MongoDB. */
export abstract class MongoQueryDriver extends ConnectionDriver<unknown> {
  /**
   * Runs one read.
   *
   * @param resource - Client, from `open()` or injected by the host.
   * @param request  - What to read.
   */
  abstract query(resource: unknown, request: MongoQueryRequest): Promise<MongoQueryResult>;
}

/** Whether `driver` can run Mongo reads. */
export function isMongoDriver(driver: ConnectionDriver): driver is MongoQueryDriver {
  return typeof (driver as MongoQueryDriver).query === 'function';
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural typing of the `mongodb` surface actually used
// ─────────────────────────────────────────────────────────────────────────────

interface MongoCursor {
  toArray(): Promise<Record<string, unknown>[]>;
}

interface MongoCollection {
  find(filter: Record<string, unknown>, options: Record<string, unknown>): MongoCursor;
  aggregate(pipeline: unknown[], options: Record<string, unknown>): MongoCursor;
}

interface MongoDb {
  collection(name: string): MongoCollection;
}

interface MongoClientLike {
  db(name?: string): MongoDb;
  close(): Promise<void>;
  connect?: () => Promise<unknown>;
}

/** Whether `value` looks like a `MongoClient` — enough to accept an injected one. */
function isMongoClient(value: unknown): value is MongoClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MongoClientLike).db === 'function'
  );
}

/**
 * MongoDB driver built on the official `mongodb` package.
 *
 * `mongodb` is already an `optionalDependency` of the SDK and is imported
 * dynamically, so nothing loads it until a Mongo tool actually runs.
 *
 * ### Read-only in practice
 * This driver exposes only `find` and `aggregate`, and the guards refuse `$out`
 * and `$merge`. As with SQL, that is defence in depth: the guarantee is a
 * database user holding the `read` role on the exposed collections.
 */
export class MongoDriver extends MongoQueryDriver {
  override readonly name = 'mongo';

  /** Database name per open resource, so `query()` can reach the right db. */
  readonly #databases = new WeakMap<object, string | undefined>();

  /**
   * Opens a client from the connection config and credential.
   *
   * @param config     - The `mongo` connection declaration.
   * @param credential - Resolved credential; `basic` supplies auth.
   * @throws {@link ConnectionError} when `mongodb` is not installed.
   */
  override async open(config: ConnectionConfig, credential: Credential): Promise<unknown> {
    if (config.type !== 'mongo') {
      throw new ConnectionError(this.name, `expected a mongo connection, got '${config.type}'`);
    }
    const mongo = await importMongo();
    const client = new mongo.MongoClient(config.url ?? '', buildOptions(config, credential));
    await client.connect?.();
    this.#databases.set(client as object, config.database);
    return client;
  }

  /** Closes the client. Never throws: it runs during shutdown. */
  override async close(resource: unknown): Promise<void> {
    if (isMongoClient(resource)) {
      await resource.close();
    }
  }

  /**
   * Runs a find or an aggregation.
   *
   * @param resource - The client.
   * @param request  - What to read.
   * @throws {@link ConnectionError} when the resource is not a Mongo client.
   */
  override async query(resource: unknown, request: MongoQueryRequest): Promise<MongoQueryResult> {
    if (!isMongoClient(resource)) {
      throw new ConnectionError(
        this.name,
        'the resource is not a MongoClient. Injected connections must supply one.',
      );
    }

    const database = this.#databases.get(resource as object);
    const collection = resource.db(database).collection(request.collection);

    const rows =
      request.pipeline !== undefined
        ? await collection
            .aggregate([...request.pipeline, { $limit: request.limit }], {
              maxTimeMS: request.maxTimeMs,
            })
            .toArray()
        : await collection
            .find(request.filter ?? {}, {
              ...(request.projection !== undefined && { projection: request.projection }),
              ...(request.sort !== undefined && { sort: request.sort }),
              limit: request.limit,
              maxTimeMS: request.maxTimeMs,
            })
            .toArray();

    return { rows };
  }
}

/** Client options assembled from the declaration and the credential. */
function buildOptions(
  config: MongoConnectionConfig,
  credential: Credential,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (config.pool?.max !== undefined) options['maxPoolSize'] = config.pool.max;
  if (config.pool?.idleTimeoutMs !== undefined) {
    options['maxIdleTimeMS'] = config.pool.idleTimeoutMs;
  }

  if (credential.kind === 'basic') {
    options['auth'] = { username: credential.username, password: credential.password };
  } else if (credential.kind === 'custom') {
    Object.assign(options, credential.value);
  }

  return options;
}

/** The slice of the `mongodb` module namespace this driver needs. */
interface MongoModule {
  MongoClient: new (url: string, options: Record<string, unknown>) => MongoClientLike;
}

/**
 * Imports `mongodb` dynamically, turning a missing install into a clear message.
 *
 * @throws {@link ConnectionError} when the package is absent.
 */
async function importMongo(): Promise<MongoModule> {
  try {
    const specifier = 'mongodb';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: MongoModule;
      MongoClient?: MongoModule['MongoClient'];
    };
    const resolved = mod.MongoClient !== undefined ? (mod as MongoModule) : mod.default;
    if (resolved?.MongoClient === undefined) {
      throw new Error("the 'mongodb' module exposes no MongoClient export");
    }
    return resolved;
  } catch (err) {
    throw new ConnectionError(
      'mongo',
      "the 'mongodb' package is required by MongoDriver but could not be loaded. " +
        'Install it (`npm install mongodb`), or inject an already-open client via ' +
        'OrchestratorOverrides.connections.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
