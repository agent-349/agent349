import { ConnectionError } from '../../../errors/index.js';
import type { ConnectionConfig, SqlConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import { MsSqlDialect } from './dialects.js';
import type { SqlDialect } from './dialects.js';
import { SqlDriver } from './SqlDriver.js';
import type { SqlQueryRequest, SqlQueryResult } from './SqlDriver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Structural typing of the `mssql` surface actually used
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a `mssql` result this driver reads. */
interface MsSqlResult {
  recordset?: Record<string, unknown>[];
  recordsets?: Record<string, unknown>[][];
}

/** The part of a `mssql.Request` this driver touches. */
interface MsSqlRequest {
  input(name: string, value: unknown): MsSqlRequest;
  query(text: string): Promise<MsSqlResult>;
  timeout?: number;
}

/** The part of a `mssql.Transaction` this driver touches. */
interface MsSqlTransaction {
  begin(): Promise<unknown>;
  rollback(): Promise<unknown>;
  request(): MsSqlRequest;
}

/** The part of a `mssql.ConnectionPool` this driver touches. */
interface MsSqlPool {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  transaction(): MsSqlTransaction;
}

/** Whether `value` looks like a connected `mssql` pool. */
function isMsSqlPool(value: unknown): value is MsSqlPool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MsSqlPool).transaction === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MsSqlDriver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Microsoft SQL Server driver built on `mssql`.
 *
 * ### The dependency
 * `mssql` is an optional dependency, imported dynamically, so it costs nothing
 * to consumers that never touch SQL Server.
 *
 * ### Read-only: weaker here than anywhere else, and worth knowing
 * T-SQL has no `BEGIN READ ONLY`. Every other engine the SDK supports refuses a
 * write inside the transaction the dialect opens; SQL Server cannot. What this
 * driver does instead is run every statement inside a transaction it **always
 * rolls back**, so a write that got past the syntactic guards is undone rather
 * than prevented.
 *
 * That is a real difference, not a formality:
 *
 * - A rollback cannot undo what was never transactional — a procedure with an
 *   external side effect, for instance.
 * - The window between the write and the rollback is real, however short.
 *
 * So on SQL Server the **database user's grants carry the weight** that the
 * engine carries elsewhere. `readOnlyUser: true` should be verified against the
 * server's own permissions, not assumed.
 *
 * @example
 * ```typescript
 * orch.connections.registerDriver(new MsSqlDriver());   // driver: "mssql"
 * ```
 */
export class MsSqlDriver extends SqlDriver {
  override readonly name = 'mssql';
  override readonly dialect: SqlDialect = new MsSqlDialect();

  /**
   * Opens and connects a pool.
   *
   * @throws {@link ConnectionError} when `mssql` is not installed.
   */
  override async open(config: ConnectionConfig, credential: Credential): Promise<unknown> {
    if (config.type !== 'sql') {
      throw new ConnectionError(this.name, `expected a sql connection, got '${config.type}'`);
    }

    const mssql = await importMsSql();
    const pool = new mssql.ConnectionPool(buildPoolOptions(config, credential));
    await pool.connect();
    return pool;
  }

  /** Closes the pool. Never throws: it runs during shutdown. */
  override async close(resource: unknown): Promise<void> {
    if (isMsSqlPool(resource)) {
      await resource.close();
    }
  }

  /**
   * Runs one statement inside a transaction that is always rolled back.
   *
   * The transaction is opened through the client API rather than with a raw
   * `BEGIN TRANSACTION`, and that is the whole point: on a pool, a raw BEGIN
   * would leave the transaction on one connection while the next statement ran
   * on another. A `Transaction` pins one connection for the exchange.
   *
   * @throws {@link ConnectionError} when the resource is not a usable pool;
   *         otherwise the driver's own error.
   */
  override async query(resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    if (!isMsSqlPool(resource)) {
      throw new ConnectionError(
        this.name,
        'the resource is not a connected mssql pool. Injected connections must supply one.',
      );
    }

    const guards = this.dialect.sessionGuards(request.timeoutMs);
    const transaction = resource.transaction();
    await transaction.begin();

    try {
      for (const statement of guards.before) {
        await transaction.request().query(statement);
      }

      const payload = transaction.request();
      // T-SQL has no session statement timeout; the client cancels the request
      // server-side, which is the equivalent guarantee.
      payload.timeout = request.timeoutMs;
      request.values.forEach((value, index) => {
        payload.input(`p${index + 1}`, value);
      });
      const result = await payload.query(request.text);

      await transaction.request().query(guards.after);

      const rows = result.recordset ?? result.recordsets?.[0] ?? [];
      return {
        rows,
        // `mssql` exposes column order on the recordset itself; falling back to
        // the first row keeps the shape right when it is absent.
        fields: columnsOf(result, rows),
      };
    } finally {
      // Always. A read loses nothing by it, and a write that slipped through
      // every other guard is undone.
      await transaction.rollback().catch(() => undefined);
    }
  }
}

/** Column names in selection order. */
function columnsOf(result: MsSqlResult, rows: Record<string, unknown>[]): string[] {
  const meta = (result.recordset as unknown as { columns?: Record<string, unknown> } | undefined)
    ?.columns;
  if (meta !== undefined) return Object.keys(meta);
  return rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
}

/** Pool options assembled from the declaration and the resolved credential. */
function buildPoolOptions(
  config: SqlConnectionConfig,
  credential: Credential,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    options: { trustServerCertificate: true, encrypt: false },
  };

  if (config.url !== undefined) options['connectionString'] = config.url;
  if (config.host !== undefined) options['server'] = config.host;
  if (config.port !== undefined) options['port'] = config.port;
  if (config.database !== undefined) options['database'] = config.database;
  if (config.pool?.max !== undefined) options['pool'] = { max: config.pool.max };
  if (config.pool?.idleTimeoutMs !== undefined) {
    options['pool'] = {
      ...(options['pool'] as object),
      idleTimeoutMillis: config.pool.idleTimeoutMs,
    };
  }

  switch (credential.kind) {
    case 'basic':
      options['user'] = credential.username;
      options['password'] = credential.password;
      break;
    case 'custom':
      // Escape hatch for TLS material, instance names, domain auth, and
      // anything else `mssql` accepts that the connection schema does not model.
      Object.assign(options, credential.value);
      break;
    case 'none':
    case 'bearer':
    case 'apiKey':
      break;
  }

  return options;
}

/** The slice of the `mssql` module namespace this driver needs. */
interface MsSqlModule {
  ConnectionPool: new (options: Record<string, unknown>) => MsSqlPool;
}

/**
 * Imports `mssql` dynamically, turning a missing install into a clear message.
 *
 * @throws {@link ConnectionError} when the package is absent.
 */
async function importMsSql(): Promise<MsSqlModule> {
  try {
    const specifier = 'mssql';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: MsSqlModule;
      ConnectionPool?: MsSqlModule['ConnectionPool'];
    };
    const resolved = mod.ConnectionPool !== undefined ? (mod as MsSqlModule) : mod.default;
    if (resolved?.ConnectionPool === undefined) {
      throw new Error("the 'mssql' module exposes no ConnectionPool export");
    }
    return resolved;
  } catch (err) {
    throw new ConnectionError(
      'mssql',
      "the 'mssql' package is required by MsSqlDriver but could not be loaded. " +
        'Install it in the host application (`npm install mssql`), or inject an ' +
        'already-connected pool via OrchestratorOverrides.connections.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
