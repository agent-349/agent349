import { ValidationError } from '../../../errors/index.js';
import type {
  ConnectionHandle,
  MongoConnectionConfig,
  RelationDescriptor,
} from '../../../connections/types.js';
import type { Tool, ToolResult } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';

/** Configuration for {@link createMongoSchemaTool}. */
export interface MongoSchemaToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `mongo` connection whose catalogue to serve. */
  connection: string;
  /** Description sent to the LLM. Generated when omitted. */
  description?: string;
}

/**
 * Builds a `mongo.schema` tool: the catalogue a model reads before querying.
 *
 * MongoDB has no declared schema, so the catalogue is **curated** — the
 * integrator describes the collections and fields, exactly as for SQL.
 *
 * Inferring it by sampling documents was considered and rejected: sampling puts
 * real, possibly personal, data into a description that travels to the model on
 * every turn. If it is ever added it will be opt-in and say so loudly.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} when the connection declares no collections.
 */
export function createMongoSchemaTool(
  config: MongoSchemaToolConfig,
  ctx: InternalToolContext,
): Tool {
  const name = config.name ?? 'mongo.schema';
  const handle = ctx.getConnection(config.connection);
  const connection = assertMongoConnection(handle, name);
  const relations = connection.relations ?? [];

  if (relations.length === 0) {
    throw new ValidationError(
      `${name}.connection`,
      `connection '${handle.name}' declares no collections, so there is no catalogue to serve. ` +
        'Add a `relations` array to the connection: it is both the allowlist and the grounding.',
    );
  }

  const names = relations.map((relation) => relation.name);

  return {
    name,
    description:
      config.description ??
      `Describes the MongoDB collections available for querying, with their fields. ` +
        `Call this before composing a query. Available: ${names.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        collections: {
          type: 'array',
          items: { type: 'string' },
          description: `Names to describe. Omit for the whole catalogue. Known: ${names.join(', ')}.`,
        },
      },
      additionalProperties: false,
    },

    async execute(input: { collections?: unknown }): Promise<ToolResult> {
      const requested = Array.isArray(input?.collections)
        ? (input.collections as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];

      const selected =
        requested.length === 0
          ? relations
          : relations.filter((relation) =>
              requested.some((asked) => asked.toLowerCase() === relation.name.toLowerCase()),
            );

      if (selected.length === 0) {
        return { success: false, error: `No collection matched. Available: ${names.join(', ')}.` };
      }

      return {
        success: true,
        data: {
          engine: 'mongodb',
          collections: selected.map(toView),
          notice:
            'These are the only collections you can query. Use exactly these names and fields.',
        },
      };
    },
  };
}

/** Strips a descriptor down to what helps the model. */
function toView(relation: RelationDescriptor): {
  name: string;
  description?: string;
  fields?: { name: string; type?: string; description?: string }[];
} {
  return {
    name: relation.name,
    ...(relation.description !== undefined && { description: relation.description }),
    ...(relation.columns !== undefined && {
      fields: relation.columns.map((column) => ({
        name: column.name,
        ...(column.type !== undefined && { type: column.type }),
        ...(column.description !== undefined && { description: column.description }),
      })),
    }),
  };
}

/** Narrows the connection behind `handle` to a Mongo one. */
function assertMongoConnection(handle: ConnectionHandle, toolName: string): MongoConnectionConfig {
  if (handle.config.type !== 'mongo') {
    throw new ValidationError(
      `${toolName}.connection`,
      `connection '${handle.name}' is of type '${handle.config.type}'; mongo.schema needs a mongo connection`,
    );
  }
  return handle.config;
}
