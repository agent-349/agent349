import { ConnectionError } from '../../../errors/index.js';
import type { ConnectionConfig, SqlConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import { MySqlDialect } from './dialects.js';
import type { SqlDialect } from './dialects.js';
import { SqlDriver } from './SqlDriver.js';
import type { SqlQueryRequest, SqlQueryResult } from './SqlDriver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Structural typing of the `mysql2/promise` surface actually used
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a `mysql2` field descriptor this driver reads. */
interface MySqlField {
  name: string;
}

/** The part of a pooled `mysql2` connection this driver touches. */
interface MySqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, MySqlField[] | undefined]>;
  execute(sql: string, values?: unknown[]): Promise<[unknown, MySqlField[] | undefined]>;
  release(): void;
}

/** The part of a `mysql2` pool this driver touches. */
interface MySqlPool {
  getConnection(): Promise<MySqlConnection>;
  end(): Promise<void>;
}

/** Whether `value` looks like a `mysql2` pool — enough to accept an injected one. */
function isMySqlPool(value: unknown): value is MySqlPool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MySqlPool).getConnection === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MySqlDriver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MySQL and MariaDB driver built on `mysql2/promise`.
 *
 * ### The dependency
 * `mysql2` is an optional dependency, imported dynamically, so it costs nothing
 * to consumers that never touch MySQL. Without it, the failure arrives on first
 * use with an actionable message rather than at startup.
 *
 * ### Read-only by construction
 * Every statement runs inside `START TRANSACTION READ ONLY` with a session
 * execution cap. A write is refused by the engine itself (error 1792), whatever
 * the statement says and whatever grants the user holds — the same guarantee
 * PostgreSQL gives, and the reason the syntactic guards can honestly be
 * described as secondary.
 *
 * ### MariaDB
 * Same driver, different id and timeout variable. Register the flavour whose
 * name matches the `driver` field of the connection:
 *
 * @example
 * ```typescript
 * orch.connections.registerDriver(new MySqlDriver());            // driver: 'mysql'
 * orch.connections.registerDriver(new MySqlDriver('mariadb'));   // driver: 'mariadb'
 * ```
 */
export class MySqlDriver extends SqlDriver {
  override readonly name: string;
  override readonly dialect: SqlDialect;

  /**
   * @param flavor - `'mysql'` (default) or `'mariadb'`. Sets both the driver id
   *                 matched against `connection.driver` and the dialect.
   */
  constructor(flavor: 'mysql' | 'mariadb' = 'mysql') {
    super();
    this.name = flavor;
    this.dialect = new MySqlDialect(flavor);
  }

  /**
   * Opens a connection pool from the connection config and credential.
   *
   * @param config     - The `sql` connection declaration.
   * @param credential - Resolved credential; `basic` supplies user and password.
   * @returns The live `mysql2` pool.
   * @throws {@link ConnectionError} when `mysql2` is not installed.
   */
  override async open(config: ConnectionConfig, credential: Credential): Promise<unknown> {
    if (config.type !== 'sql') {
      throw new ConnectionError(this.name, `expected a sql connection, got '${config.type}'`);
    }

    const mysql = await importMySql(this.name);
    return mysql.createPool(buildPoolOptions(config, credential));
  }

  /**
   * Closes the pool. Never throws: it runs during shutdown.
   *
   * @param resource - The pool to close.
   */
  override async close(resource: unknown): Promise<void> {
    if (isMySqlPool(resource)) {
      await resource.end();
    }
  }

  /**
   * Runs one statement inside a read-only, time-bounded transaction.
   *
   * The statement goes through `execute()`, which prepares it server-side, so
   * values are bound by the engine and never spliced into the SQL text. The
   * session guards go through `query()` instead: `SET` and transaction control
   * cannot be prepared.
   *
   * @param resource - The pool.
   * @param request  - Statement, values and timeout.
   * @returns Rows and column names.
   * @throws {@link ConnectionError} when the resource is not a usable pool;
   *         otherwise the driver's own error, so the caller can decide whether
   *         the model may see it.
   */
  override async query(resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    if (!isMySqlPool(resource)) {
      throw new ConnectionError(
        this.name,
        'the resource is not a mysql2 pool. Injected connections must supply one.',
      );
    }

    const guards = this.dialect.sessionGuards(request.timeoutMs);
    const connection = await resource.getConnection();
    try {
      for (const statement of guards.before) {
        await connection.query(statement);
      }

      let rows: unknown;
      let fields: MySqlField[] | undefined;
      try {
        [rows, fields] = await connection.execute(request.text, request.values);
      } catch (err) {
        // Leaving the transaction open would poison the pooled connection for
        // whoever picks it up next.
        await connection.query('ROLLBACK').catch(() => undefined);
        throw err;
      }

      await connection.query(guards.after);

      return {
        // A non-SELECT would return an OkPacket rather than an array. The
        // guards make that unreachable, and an empty result is a truthful
        // answer if it ever happens.
        rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
        fields: (fields ?? []).map((field) => field.name),
      };
    } finally {
      connection.release();
    }
  }
}

/** Pool options assembled from the declaration and the resolved credential. */
function buildPoolOptions(
  config: SqlConnectionConfig,
  credential: Credential,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (config.url !== undefined) options['uri'] = config.url;
  if (config.host !== undefined) options['host'] = config.host;
  if (config.port !== undefined) options['port'] = config.port;
  if (config.database !== undefined) options['database'] = config.database;
  if (config.pool?.max !== undefined) options['connectionLimit'] = config.pool.max;
  if (config.pool?.idleTimeoutMs !== undefined) {
    options['idleTimeout'] = config.pool.idleTimeoutMs;
  }

  switch (credential.kind) {
    case 'basic':
      options['user'] = credential.username;
      options['password'] = credential.password;
      break;
    case 'custom':
      // An escape hatch for TLS material and anything else `mysql2` accepts
      // that the connection schema does not model.
      Object.assign(options, credential.value);
      break;
    case 'none':
    case 'bearer':
    case 'apiKey':
      break;
  }

  return options;
}

/** The slice of the `mysql2/promise` module namespace this driver needs. */
interface MySqlModule {
  createPool: (options: Record<string, unknown>) => MySqlPool;
}

/**
 * Imports `mysql2/promise` dynamically, turning a missing install into a clear
 * message.
 *
 * @param driverName - Flavour id, so the error names the driver that failed.
 * @throws {@link ConnectionError} when the package is absent.
 */
async function importMySql(driverName: string): Promise<MySqlModule> {
  try {
    // The specifier is held in a variable so the compiler does not try to
    // resolve `mysql2` at build time: it is optional, and consumers that never
    // touch MySQL should not need it present to typecheck or build.
    const specifier = 'mysql2/promise';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: MySqlModule;
      createPool?: MySqlModule['createPool'];
    };
    // `mysql2` ships CommonJS, so ESM consumers may find it under `default`.
    const resolved = mod.createPool !== undefined ? (mod as MySqlModule) : mod.default;
    if (resolved?.createPool === undefined) {
      throw new Error("the 'mysql2/promise' module exposes no createPool export");
    }
    return resolved;
  } catch (err) {
    throw new ConnectionError(
      driverName,
      "the 'mysql2' package is required by MySqlDriver but could not be loaded. " +
        'Install it in the host application (`npm install mysql2`), or inject an ' +
        'already-open pool via OrchestratorOverrides.connections.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
