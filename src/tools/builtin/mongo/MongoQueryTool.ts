import { ConnectionError, QueryRejectedError, ValidationError } from '../../../errors/index.js';
import type { ConnectionHandle, MongoConnectionConfig } from '../../../connections/types.js';
import type { ExecutionContext, ResourceLimits, Tool, ToolResult } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { buildInputSchema, resolveBindings, validateBindings } from '../binding.js';
import type { BindingMap } from '../binding.js';
import { fetchSize, resolveLimits, toCollectionResult } from '../limits.js';
import { fillMongoTemplate, guardCollection, guardFilter, guardPipeline } from './guards.js';
import { isMongoDriver } from './MongoDriver.js';

/** How a `mongo.query` tool decides what to read. */
export type MongoQueryMode = 'declared' | 'freeform';

/** Configuration for {@link createMongoQueryTool}. */
export interface MongoQueryToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `mongo` connection. */
  connection: string;
  /** `'declared'` (default) or `'freeform'`. */
  mode?: MongoQueryMode;
  /** Description sent to the LLM. Generated for `freeform` when omitted. */
  description?: string;

  // ── declared ──────────────────────────────────────────────────────────────
  /** Collection to read. Required in `declared` mode. */
  collection?: string;
  /** Filter template, with `:name` markers. */
  filter?: Record<string, unknown>;
  /** Aggregation template, with `:name` markers. Takes precedence over `filter`. */
  pipeline?: unknown[];
  /** Fields returned. */
  projection?: Record<string, unknown>;
  /** Sort specification. */
  sort?: Record<string, unknown>;
  /** Where each marker's value comes from. */
  params?: BindingMap;

  /** Caps for this tool, lowered against the connection's. */
  limits?: ResourceLimits;
}

/**
 * Builds a `mongo.query` tool.
 *
 * Mirrors `sql.query`: `declared` runs a read the integrator wrote, `freeform`
 * lets the model compose one. The differences are the engine's, not the
 * design's — Mongo needs guards against operators that run JavaScript on the
 * server and against aggregation stages that write.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} for a malformed declaration.
 */
export function createMongoQueryTool(config: MongoQueryToolConfig, ctx: InternalToolContext): Tool {
  const name = config.name ?? 'mongo.query';
  const mode: MongoQueryMode = config.mode ?? 'declared';

  const handle = ctx.getConnection(config.connection);
  const connection = assertMongoConnection(handle, name);
  const collections = (connection.relations ?? []).map((relation) => relation.name);
  const limits = resolveLimits(config.limits, connection.limits);

  if (mode === 'declared') {
    return declaredTool(name, config, handle, collections, limits);
  }

  if (connection.readOnlyUser !== true) {
    ctx.emit('security.sql.unrestricted', {
      toolName: name,
      connection: handle.name,
      engine: 'mongo',
      reason:
        'a free-form Mongo tool is declared on a connection that does not assert ' +
        'readOnlyUser: true. The guards refuse write stages, but a database user ' +
        'holding only the read role on the exposed collections is what actually ' +
        'bounds it.',
    });
  }

  return freeformTool(name, config, handle, collections, limits, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared mode
// ─────────────────────────────────────────────────────────────────────────────

function declaredTool(
  name: string,
  config: MongoQueryToolConfig,
  handle: ConnectionHandle,
  collections: string[],
  limits: ReturnType<typeof resolveLimits>,
): Tool {
  const collection = config.collection;
  if (collection === undefined || collection === '') {
    throw new ValidationError(
      `${name}.collection`,
      'a declared mongo.query tool needs a collection. Set mode "freeform" to let the model choose.',
    );
  }
  guardCollection(collection, { allowedCollections: collections });

  const params = config.params ?? {};
  validateBindings(params, `${name}.params`);

  // Checked once, at load: a declared template that reaches for a code
  // operator is a mistake worth catching before it ever runs.
  if (config.pipeline !== undefined) {
    guardPipeline(config.pipeline, { allowedCollections: collections });
  } else {
    guardFilter(config.filter ?? {});
  }

  return {
    name,
    description: config.description ?? `Reads '${collection}' on '${handle.name}'.`,
    inputSchema: buildInputSchema(params),
    async execute(input: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
      const values = resolveBindings(params, input ?? {}, context);

      const request = {
        collection,
        ...(config.pipeline !== undefined
          ? { pipeline: fillMongoTemplate(config.pipeline, values) as unknown[] }
          : { filter: fillMongoTemplate(config.filter ?? {}, values) as Record<string, unknown> }),
        ...(config.projection !== undefined && { projection: config.projection }),
        ...(config.sort !== undefined && { sort: config.sort }),
        limit: fetchSize(limits),
        maxTimeMs: limits.timeoutMs,
      };

      return runQuery(handle, context, request, limits);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-form mode
// ─────────────────────────────────────────────────────────────────────────────

function freeformTool(
  name: string,
  config: MongoQueryToolConfig,
  handle: ConnectionHandle,
  collections: string[],
  limits: ReturnType<typeof resolveLimits>,
  ctx: InternalToolContext,
): Tool {
  const scope =
    collections.length > 0
      ? ` You may only read these collections: ${collections.join(', ')}.`
      : '';

  return {
    name,
    description:
      config.description ??
      `Reads documents from MongoDB with a filter or an aggregation pipeline.${scope} ` +
        'Results are capped, and the response says so when it was truncated. Call the ' +
        'schema tool first if you do not know the fields.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection to read.' },
        filter: {
          type: 'object',
          description: 'MongoDB query filter. Omit when using a pipeline.',
          additionalProperties: true,
        },
        pipeline: {
          type: 'array',
          description: 'Read-only aggregation stages. Takes precedence over `filter`.',
          items: { type: 'object', additionalProperties: true },
        },
        projection: {
          type: 'object',
          description: 'Fields to return.',
          additionalProperties: true,
        },
        sort: { type: 'object', description: 'Sort specification.', additionalProperties: true },
      },
      required: ['collection'],
      additionalProperties: false,
    },
    async execute(
      input: {
        collection?: unknown;
        filter?: unknown;
        pipeline?: unknown;
        projection?: unknown;
        sort?: unknown;
      },
      context: ExecutionContext,
    ): Promise<ToolResult> {
      const collection = typeof input?.collection === 'string' ? input.collection : '';
      if (collection === '') {
        return { success: false, error: 'No collection was supplied.' };
      }

      try {
        guardCollection(collection, { allowedCollections: collections });
        if (input.pipeline !== undefined) {
          guardPipeline(input.pipeline, { allowedCollections: collections });
        } else {
          guardFilter(input.filter ?? {});
        }
      } catch (err) {
        if (err instanceof QueryRejectedError) {
          ctx.emit('tool.query.rejected', {
            toolName: name,
            connection: handle.name,
            control: err.control,
            reason: err.message,
          });
          // Returned rather than thrown, so the model can correct itself.
          return { success: false, error: err.message };
        }
        throw err;
      }

      const request = {
        collection,
        ...(input.pipeline !== undefined
          ? { pipeline: input.pipeline as unknown[] }
          : { filter: (input.filter ?? {}) as Record<string, unknown> }),
        ...(isRecord(input.projection) && { projection: input.projection }),
        ...(isRecord(input.sort) && { sort: input.sort }),
        limit: fetchSize(limits),
        maxTimeMs: limits.timeoutMs,
      };

      return runQuery(handle, context, request, limits);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared execution
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the driver and resource, runs the read, and shapes the result. */
async function runQuery(
  handle: ConnectionHandle,
  context: ExecutionContext,
  request: Parameters<import('./MongoDriver.js').MongoQueryDriver['query']>[1],
  limits: ReturnType<typeof resolveLimits>,
): Promise<ToolResult> {
  const driver = handle.driver();
  if (!isMongoDriver(driver)) {
    throw new ConnectionError(
      handle.name,
      `driver '${driver.name}' cannot run queries; it must extend MongoQueryDriver`,
    );
  }

  const resource = await handle.resource(context);

  try {
    const result = await driver.query(resource, request);
    return { success: true, data: toCollectionResult(result.rows, limits, 'documents') };
  } catch (err) {
    return {
      success: false,
      error: `The database rejected the query: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Whether a model-supplied value is a usable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows the connection behind `handle` to a Mongo one. */
function assertMongoConnection(handle: ConnectionHandle, toolName: string): MongoConnectionConfig {
  if (handle.config.type !== 'mongo') {
    throw new ValidationError(
      `${toolName}.connection`,
      `connection '${handle.name}' is of type '${handle.config.type}'; mongo.query needs a mongo connection`,
    );
  }
  return handle.config;
}
