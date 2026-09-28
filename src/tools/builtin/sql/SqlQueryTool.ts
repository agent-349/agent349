import { ConnectionError, QueryRejectedError, ValidationError } from '../../../errors/index.js';
import type { ConnectionHandle, SqlConnectionConfig } from '../../../connections/types.js';
import type { ExecutionContext, ResourceLimits, Tool, ToolResult } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { buildInputSchema, resolveBindings, validateBindings } from '../binding.js';
import type { BindingMap } from '../binding.js';
import { fetchSize, resolveLimits, toCollectionResult } from '../limits.js';
import { dialectFor } from './dialects.js';
import type { SqlDialect } from './dialects.js';
import { guardFreeformSql } from './guards.js';
import { isSqlDriver } from './SqlDriver.js';

/** How a `sql.query` tool decides what to run. */
export type SqlQueryMode = 'declared' | 'freeform';

/** Configuration for {@link createSqlQueryTool}. */
export interface SqlQueryToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `sql` connection in the `connections` section. */
  connection: string;
  /**
   * `'declared'` (default) runs a statement written by the integrator;
   * `'freeform'` runs one written by the model.
   */
  mode?: SqlQueryMode;
  /** Description sent to the LLM. Generated for `freeform` when omitted. */
  description?: string;

  // ── declared ──────────────────────────────────────────────────────────────
  /** The statement, using `:name` placeholders. Required in `declared` mode. */
  statement?: string;
  /** Where each placeholder's value comes from. */
  params?: BindingMap;

  // ── freeform ──────────────────────────────────────────────────────────────
  /**
   * Whether a database error is returned verbatim to the model.
   *
   * Defaults to `true` in `freeform` (the model already knows the schema, so
   * the error reveals nothing new and lets it fix the query on the next
   * iteration) and `false` in `declared`, where it would leak structure the
   * model was never shown.
   */
  exposeDriverErrors?: boolean;

  /** Caps for this tool. Lowered against the connection's, never raised. */
  limits?: ResourceLimits;
}

/**
 * Builds a `sql.query` tool.
 *
 * ### Two modes
 * **`declared`** is the safe default: the integrator writes the statement and
 * the model only fills the parameters marked `model`. Everything else — the
 * identity a query is scoped to, above all — comes from the execution context
 * and is unreachable from the model's side.
 *
 * **`freeform`** lets the model write the SQL. It is what makes
 * natural-language querying possible, paired with `sql.schema` so the model
 * knows what it may read. Its guards are described in {@link guardFreeformSql},
 * including what they do not guarantee.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} for a malformed declaration.
 *
 * @example
 * ```typescript
 * orch.registerTool(createSqlQueryTool({
 *   name: 'sales.byCustomer',
 *   connection: 'erp',
 *   statement: 'SELECT date, amount FROM v_sales WHERE customer_id = :customerId',
 *   params: { customerId: { from: 'context', path: 'metadata.customerId', required: true } },
 * }, orch.toolServices));
 * ```
 */
export function createSqlQueryTool(config: SqlQueryToolConfig, ctx: InternalToolContext): Tool {
  const name = config.name ?? 'sql.query';
  const mode: SqlQueryMode = config.mode ?? 'declared';

  const handle = ctx.getConnection(config.connection);
  const connection = assertSqlConnection(handle, name);
  const dialect = dialectFor(connection.driver);

  return mode === 'declared'
    ? declaredTool(name, config, handle, connection, dialect)
    : freeformTool(name, config, handle, connection, dialect, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared mode
// ─────────────────────────────────────────────────────────────────────────────

function declaredTool(
  name: string,
  config: SqlQueryToolConfig,
  handle: ConnectionHandle,
  connection: SqlConnectionConfig,
  dialect: SqlDialect,
): Tool {
  const statement = config.statement;
  if (statement === undefined || statement.trim() === '') {
    throw new ValidationError(
      `${name}.statement`,
      'a declared sql.query tool needs a statement. Set mode "freeform" to let the model write one.',
    );
  }

  const params = config.params ?? {};
  validateBindings(params, `${name}.params`);

  const prepared = dialect.prepare(statement);
  for (const placeholder of prepared.order) {
    if (!(placeholder in params)) {
      throw new ValidationError(
        `${name}.params`,
        `the statement uses ':${placeholder}' but no binding declares where its value comes from`,
      );
    }
  }

  const limits = resolveLimits(config.limits, connection.limits);
  const capped = dialect.applyLimit(prepared.text, fetchSize(limits));

  return {
    name,
    description: config.description ?? `Runs a predefined query on '${handle.name}'.`,
    inputSchema: buildInputSchema(params),
    async execute(input: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
      const bound = resolveBindings(params, input ?? {}, context);
      const values = prepared.order.map((placeholder) => bound[placeholder] ?? null);

      return runQuery(handle, context, {
        text: capped,
        values,
        timeoutMs: limits.timeoutMs,
        limits,
        exposeDriverErrors: config.exposeDriverErrors ?? false,
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-form mode
// ─────────────────────────────────────────────────────────────────────────────

function freeformTool(
  name: string,
  config: SqlQueryToolConfig,
  handle: ConnectionHandle,
  connection: SqlConnectionConfig,
  dialect: SqlDialect,
  ctx: InternalToolContext,
): Tool {
  const relations = (connection.relations ?? []).map((relation) => relation.name);
  const limits = resolveLimits(config.limits, connection.limits);

  // Dangerous but explicit: the integrator can live with the warning, but
  // cannot say they were not told. See TOOLS1.md §6.2.
  if (connection.readOnlyUser !== true) {
    ctx.emit('security.sql.unrestricted', {
      toolName: name,
      connection: handle.name,
      reason:
        'a free-form SQL tool is declared on a connection that does not assert ' +
        'readOnlyUser: true. Statements run inside a read-only transaction, but ' +
        'scoping the database user to the exposed relations is what actually ' +
        'bounds what it can read.',
    });
  }

  return {
    name,
    description: config.description ?? describeFreeform(dialect, relations),
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            `A single read-only ${dialect.name} SELECT statement. ` +
            'Use :name placeholders for values and pass them in `params` — never ' +
            'paste values into the SQL text.',
        },
        params: {
          type: 'object',
          description: 'Values for the :name placeholders used in `sql`.',
          additionalProperties: true,
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    async execute(
      input: { sql?: unknown; params?: unknown },
      context: ExecutionContext,
    ): Promise<ToolResult> {
      const raw = typeof input?.sql === 'string' ? input.sql : '';

      let guarded;
      try {
        guarded = guardFreeformSql(raw, { allowedRelations: relations });
      } catch (err) {
        if (err instanceof QueryRejectedError) {
          ctx.emit('tool.query.rejected', {
            toolName: name,
            connection: handle.name,
            control: err.control,
            reason: err.message,
          });
          // Returned rather than thrown: the model can rewrite the query on
          // the next iteration, which a thrown error would deny it.
          return { success: false, error: err.message };
        }
        throw err;
      }

      const prepared = dialect.prepare(guarded.sql);
      const supplied = asRecord(input?.params);
      const missing = prepared.order.filter((placeholder) => !(placeholder in supplied));
      if (missing.length > 0) {
        return {
          success: false,
          error:
            `The query uses placeholders with no value in \`params\`: ` +
            `${missing.map((placeholder) => `:${placeholder}`).join(', ')}.`,
        };
      }

      return runQuery(handle, context, {
        text: dialect.applyLimit(prepared.text, fetchSize(limits)),
        values: prepared.order.map((placeholder) => supplied[placeholder] ?? null),
        timeoutMs: limits.timeoutMs,
        limits,
        exposeDriverErrors: config.exposeDriverErrors ?? true,
      });
    },
  };
}

/** Builds the description the LLM reads, from what the connection declares. */
function describeFreeform(dialect: SqlDialect, relations: string[]): string {
  const scope =
    relations.length > 0
      ? `You may only read these relations: ${relations.join(', ')}.`
      : 'Only relations exposed by this connection can be read.';

  // The dialect belongs here: LIMIT vs TOP vs FETCH FIRST is knowable from the
  // config, and telling the model changes how often its first attempt runs.
  return (
    `Runs a read-only ${dialect.name} SELECT query and returns the rows. ${scope} ` +
    `Write ${dialect.name} syntax. Results are capped, and the response says so when ` +
    'it was truncated. Call the schema tool first if you do not know the columns.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared execution
// ─────────────────────────────────────────────────────────────────────────────

interface RunOptions {
  text: string;
  values: unknown[];
  timeoutMs: number;
  limits: ReturnType<typeof resolveLimits>;
  exposeDriverErrors: boolean;
}

/** Resolves the driver and resource, runs the statement, and shapes the result. */
async function runQuery(
  handle: ConnectionHandle,
  context: ExecutionContext,
  options: RunOptions,
): Promise<ToolResult> {
  const driver = handle.driver();
  if (!isSqlDriver(driver)) {
    throw new ConnectionError(
      handle.name,
      `driver '${driver.name}' cannot run queries; it must extend SqlDriver`,
    );
  }

  const resource = await handle.resource(context);

  try {
    const result = await driver.query(resource, {
      text: options.text,
      values: options.values,
      timeoutMs: options.timeoutMs,
    });
    return { success: true, data: toCollectionResult(result.rows, options.limits, 'rows') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: options.exposeDriverErrors
        ? // Verbatim on purpose: "column c does not exist" lets the model fix
          // the query next iteration, where a generic failure leaves it
          // guessing until it runs out of turns.
          `The database rejected the query: ${message}`
        : 'The query could not be completed.',
    };
  }
}

/** Narrows the connection behind `handle` to a SQL one. */
function assertSqlConnection(handle: ConnectionHandle, toolName: string): SqlConnectionConfig {
  if (handle.config.type !== 'sql') {
    throw new ValidationError(
      `${toolName}.connection`,
      `connection '${handle.name}' is of type '${handle.config.type}'; sql.query needs a sql connection`,
    );
  }
  return handle.config;
}

/** Coerces the model's `params` object into a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
