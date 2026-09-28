import { ConnectionError } from '../../../errors/index.js';
import type { ConnectionConfig, SqlConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import { PostgresDialect } from './dialects.js';
import type { SqlDialect } from './dialects.js';
import { SqlDriver } from './SqlDriver.js';
import type { SqlQueryRequest, SqlQueryResult } from './SqlDriver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Structural typing of the `pg` surface actually used
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a `pg.Client` this driver touches. */
interface PgClient {
  query(text: string, values?: unknown[]): Promise<PgResult>;
  release(): void;
}

/** The part of a `pg.Pool` this driver touches. */
interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/** The part of a `pg` result this driver reads. */
interface PgResult {
  rows?: Record<string, unknown>[];
  fields?: { name: string }[];
}

/** Whether `value` looks like a `pg.Pool` — enough to accept an injected one. */
function isPgPool(value: unknown): value is PgPool {
  return (
    typeof value === 'object' && value !== null && typeof (value as PgPool).connect === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgresDriver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PostgreSQL driver built on `pg`.
 *
 * ### The dependency
 * `pg` is **not** declared by the SDK and is imported dynamically, so it costs
 * nothing to consumers that never touch SQL. Install it in the host to use
 * this driver; without it, the failure arrives on first use with an actionable
 * message rather than at startup.
 *
 * Hosts that already hold a pool should inject it via
 * `OrchestratorOverrides.connections` instead — one pool, one lifecycle. The
 * driver still has to be registered, because running a query needs it.
 *
 * ### Read-only by construction
 * Every statement runs inside `BEGIN READ ONLY` with a `SET LOCAL
 * statement_timeout`. A write is refused by PostgreSQL itself, whatever the
 * statement says and whatever grants the user holds. That is a stronger and
 * simpler guarantee than any amount of inspecting the SQL, and it is why the
 * syntactic guards can honestly be described as secondary.
 *
 * @example
 * ```typescript
 * const orch = await Orchestrator.fromConfig(config);
 * orch.connections.registerDriver(new PostgresDriver());
 * ```
 */
export class PostgresDriver extends SqlDriver {
  override readonly name = 'postgres';
  override readonly dialect: SqlDialect = new PostgresDialect();

  /**
   * Opens a connection pool from the connection config and credential.
   *
   * @param config     - The `sql` connection declaration.
   * @param credential - Resolved credential; `basic` supplies user and password.
   * @returns The live `pg.Pool`.
   * @throws {@link ConnectionError} when `pg` is not installed.
   */
  override async open(config: ConnectionConfig, credential: Credential): Promise<unknown> {
    if (config.type !== 'sql') {
      throw new ConnectionError(this.name, `expected a sql connection, got '${config.type}'`);
    }

    const pg = await importPg();
    const options = buildPoolOptions(config, credential);
    return new pg.Pool(options);
  }

  /**
   * Closes the pool. Never throws: it runs during shutdown.
   *
   * @param resource - The pool to close.
   */
  override async close(resource: unknown): Promise<void> {
    if (isPgPool(resource)) {
      await resource.end();
    }
  }

  /**
   * Runs one statement inside a read-only, time-bounded transaction.
   *
   * @param resource - The pool.
   * @param request  - Statement, values and timeout.
   * @returns Rows and column names.
   * @throws {@link ConnectionError} when the resource is not a usable pool;
   *         otherwise the driver's own error, so the caller can decide whether
   *         the model may see it.
   */
  override async query(resource: unknown, request: SqlQueryRequest): Promise<SqlQueryResult> {
    if (!isPgPool(resource)) {
      throw new ConnectionError(
        this.name,
        'the resource is not a pg Pool. Injected connections must supply one.',
      );
    }

    const guards = this.dialect.sessionGuards(request.timeoutMs);
    const client = await resource.connect();
    try {
      for (const statement of guards.before) {
        await client.query(statement);
      }

      let result: PgResult;
      try {
        result = await client.query(request.text, request.values);
      } catch (err) {
        // Leaving the transaction open would poison the pooled connection for
        // whoever picks it up next.
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }

      await client.query(guards.after);

      return {
        rows: result.rows ?? [],
        fields: (result.fields ?? []).map((field) => field.name),
      };
    } finally {
      client.release();
    }
  }
}

/** Pool options assembled from the declaration and the resolved credential. */
function buildPoolOptions(
  config: SqlConnectionConfig,
  credential: Credential,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (config.url !== undefined) options['connectionString'] = config.url;
  if (config.host !== undefined) options['host'] = config.host;
  if (config.port !== undefined) options['port'] = config.port;
  if (config.database !== undefined) options['database'] = config.database;
  if (config.pool?.max !== undefined) options['max'] = config.pool.max;
  if (config.pool?.idleTimeoutMs !== undefined) {
    options['idleTimeoutMillis'] = config.pool.idleTimeoutMs;
  }

  switch (credential.kind) {
    case 'basic':
      options['user'] = credential.username;
      options['password'] = credential.password;
      break;
    case 'custom':
      // An escape hatch for TLS material and anything else `pg` accepts that
      // the connection schema does not model.
      Object.assign(options, credential.value);
      break;
    case 'none':
    case 'bearer':
    case 'apiKey':
      break;
  }

  return options;
}

/** The slice of the `pg` module namespace this driver needs. */
interface PgModule {
  Pool: new (options: Record<string, unknown>) => PgPool;
}

/**
 * Imports `pg` dynamically, turning a missing install into a clear message.
 *
 * @throws {@link ConnectionError} when the package is absent.
 */
async function importPg(): Promise<PgModule> {
  try {
    // The specifier is held in a variable so the compiler does not try to
    // resolve `pg` at build time: the SDK does not declare it, and consumers
    // that never touch SQL should not need it present to typecheck or build.
    const specifier = 'pg';
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      default?: PgModule;
      Pool?: PgModule['Pool'];
    };
    // `pg` ships CommonJS, so ESM consumers may find it under `default`.
    const resolved = mod.Pool !== undefined ? (mod as PgModule) : mod.default;
    if (resolved?.Pool === undefined) {
      throw new Error("the 'pg' module exposes no Pool export");
    }
    return resolved;
  } catch (err) {
    throw new ConnectionError(
      'postgres',
      "the 'pg' package is required by PostgresDriver but could not be loaded. " +
        'Install it in the host application (`npm install pg`), or inject an ' +
        'already-open pool via OrchestratorOverrides.connections.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
