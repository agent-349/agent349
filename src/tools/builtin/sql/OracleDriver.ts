import { ConnectionError } from '../../../errors/index.js';
import type { ConnectionConfig, SqlConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import { OracleDialect } from './dialects.js';
import type { SqlDialect } from './dialects.js';
import { SqlDriver } from './SqlDriver.js';
import type { SqlQueryRequest, SqlQueryResult } from './SqlDriver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Structural typing of the `oracledb` surface actually used
// ─────────────────────────────────────────────────────────────────────────────

/** The part of an `oracledb` result this driver reads. */
interface OracleResult {
  rows?: Record<string, unknown>[];
  metaData?: { name: string }[];
}

/** The part of an `oracledb` connection this driver touches. */
interface OracleConnection {
  execute(sql: string, binds?: unknown[], options?: Record<string, unknown>): Promise<OracleResult>;
  close(): Promise<void>;
  callTimeout?: number;
}

/** The part of an `oracledb` pool this driver touches. */
interface OraclePool {
  getConnection(): Promise<OracleConnection>;
  close(drainTime?: number): Promise<void>;
}

/** Whether `value` looks like an `oracledb` pool. */
function isOraclePool(value: unknown): value is OraclePool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OraclePool).getConnection === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OracleDriver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Oracle Database driver built on `oracledb`.
 *
 * ### The dependency
 * `oracledb` is an optional dependency, imported dynamically. Unlike the other
 * clients it may also need Oracle Instant Client installed on the host, in
 * *thick* mode; recent versions run *thin* against 12.1+ with no external
 * libraries, which is the mode this driver assumes.
 *
 * ### Read-only by construction
 * `SET TRANSACTION READ ONLY` is enforced by the engine: a write inside fails
 * with `ORA-01456`. Same guarantee PostgreSQL and MySQL give, and the reason
 * the syntactic guards can honestly be described as secondary here too.
 *
 * @example
 * ```typescript
 * orch.connections.registerDriver(new OracleDriver());   // driver: "oracle"
 * ```
 */
export class OracleDriver extends SqlDriver {
  override readonly name = 'oracle';
  override readonly dialect: SqlDialect = new OracleDialect();

  /**
   * Opens a connection pool.
   *
   * @throws {@link ConnectionError} when `oracledb` is not installed.
   */
  override async open(config: ConnectionConfig, credential: Credential): Promise<unknown> {
    if (config.type !== 'sql') {
      throw new ConnectionError(this.name, `expected a sql connection, got '${config.type}'`);
    }

    const oracledb = await importOracle();
    // Rows as objects rather than arrays: the whole SDK speaks
    // `Record<string, unknown>`, and mapping positionally would lose the names.
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    return oracledb.createPool(buildPoolOptions(config, credential));
  }

  /** Closes the pool. Never throws: it runs during shutdown. */
  override async close(resource: unknown): Promise<void> {
    if (isOraclePool(resource)) {
      // Drain briefly so in-flight statements finish instead of being cut.
      await resource.close(2);
    }
  }

  /**
   * Runs one statement inside a read-only transaction.
   *
   * @throws {@link ConnectionError} when the resource is not a usable pool;
   *         otherwise the driver's own error.
   */
  override async query(resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    if (!isOraclePool(resource)) {
      throw new ConnectionError(
        this.name,
        'the resource is not an oracledb pool. Injected connections must supply one.',
      );
    }

    const guards = this.dialect.sessionGuards(request.timeoutMs);
    const connection = await resource.getConnection();
    // Oracle has no session statement timeout; `callTimeout` bounds each round
    // trip on this connection, which is the equivalent guarantee.
    connection.callTimeout = request.timeoutMs;

    try {
      for (const statement of guards.before) {
        await connection.execute(statement);
      }

      let result: OracleResult;
      try {
        result = await connection.execute(request.text, request.values);
      } catch (err) {
        // Leaving the read-only transaction open would carry its snapshot into
        // whatever runs next on this pooled connection.
        await connection.execute('ROLLBACK').catch(() => undefined);
        throw err;
      }

      await connection.execute(guards.after);

      return {
        rows: result.rows ?? [],
        fields: (result.metaData ?? []).map((field) => field.name),
      };
    } finally {
      await connection.close().catch(() => undefined);
    }
  }
}

/** Pool options assembled from the declaration and the resolved credential. */
function buildPoolOptions(
  config: SqlConnectionConfig,
  credential: Credential,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  // Oracle addresses a *service*, not a database file: `url` carries a full
  // connect string, and the discrete fields are assembled into an EZConnect one.
  if (config.url !== undefined) {
    options['connectString'] = config.url;
  } else if (config.host !== undefined) {
    const port = config.port ?? 1521;
    const service = config.database ?? '';
    options['connectString'] = service
      ? `${config.host}:${port}/${service}`
      : `${config.host}:${port}`;
  }

  if (config.pool?.max !== undefined) options['poolMax'] = config.pool.max;
  if (config.pool?.idleTimeoutMs !== undefined) {
    // oracledb counts this one in seconds.
    options['poolTimeout'] = Math.max(1, Math.round(config.pool.idleTimeoutMs / 1000));
  }

  switch (credential.kind) {
    case 'basic':
      options['user'] = credential.username;
      options['password'] = credential.password;
      break;
    case 'custom':
      // Escape hatch for wallets, TLS material and anything else `oracledb`
      // accepts that the connection schema does not model.
      Object.assign(options, credential.value);
      break;
    case 'none':
    case 'bearer':
    case 'apiKey':
      break;
  }

  return options;
}

/** The slice of the `oracledb` module namespace this driver needs. */
interface OracleModule {
  createPool: (options: Record<string, unknown>) => Promise<OraclePool>;
  outFormat: unknown;
  OUT_FORMAT_OBJECT: unknown;
}

/**
 * Imports `oracledb` dynamically, turning a missing install into a clear message.
 *
 * @throws {@link ConnectionError} when the package is absent.
 */
async function importOracle(): Promise<OracleModule> {
  try {
    const specifier = 'oracledb';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: OracleModule;
      createPool?: OracleModule['createPool'];
    };
    const resolved = mod.createPool !== undefined ? (mod as unknown as OracleModule) : mod.default;
    if (resolved?.createPool === undefined) {
      throw new Error("the 'oracledb' module exposes no createPool export");
    }
    return resolved;
  } catch (err) {
    throw new ConnectionError(
      'oracle',
      "the 'oracledb' package is required by OracleDriver but could not be loaded. " +
        'Install it in the host application (`npm install oracledb`), or inject an ' +
        'already-open pool via OrchestratorOverrides.connections.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
