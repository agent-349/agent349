import { ValidationError } from '../../../errors/index.js';
import type {
  ConnectionHandle,
  RelationDescriptor,
  SqlConnectionConfig,
} from '../../../connections/types.js';
import type { Tool, ToolResult } from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { dialectFor } from './dialects.js';

/** Configuration for {@link createSqlSchemaTool}. */
export interface SqlSchemaToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `sql` connection whose catalogue to serve. */
  connection: string;
  /** Description sent to the LLM. Generated when omitted. */
  description?: string;
}

/** One relation as handed to the model. */
interface RelationView {
  name: string;
  description?: string;
  columns?: { name: string; type?: string; description?: string }[];
}

/**
 * Builds a `sql.schema` tool: the catalogue a model reads before writing SQL.
 *
 * The catalogue is declared on the **connection**, not here, because it does
 * two jobs at once — it is the allowlist `sql.query` enforces in free-form
 * mode, and the grounding the model needs to write a query that runs. One
 * declaration, and the two can never drift apart.
 *
 * Serving it as a tool rather than pasting it into the system prompt keeps a
 * large catalogue out of every single turn: the model asks once, when it needs
 * it.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} when the connection is not a SQL one or
 *         declares no relations.
 *
 * @example
 * ```jsonc
 * { "name": "erp.schema", "kind": "internal", "ref": "sql.schema",
 *   "config": { "connection": "erp" } }
 * ```
 */
export function createSqlSchemaTool(config: SqlSchemaToolConfig, ctx: InternalToolContext): Tool {
  const name = config.name ?? 'sql.schema';
  const handle = ctx.getConnection(config.connection);
  const connection = assertSqlConnection(handle, name);
  const dialect = dialectFor(connection.driver);
  const relations = connection.relations ?? [];

  if (relations.length === 0) {
    throw new ValidationError(
      `${name}.connection`,
      `connection '${handle.name}' declares no relations, so there is no catalogue to serve. ` +
        'Add a `relations` array to the connection: it is both the allowlist and the grounding.',
    );
  }

  const names = relations.map((relation) => relation.name);

  return {
    name,
    description:
      config.description ??
      `Describes the ${dialect.name} relations available for querying, with their columns. ` +
        `Call this before writing SQL. Available: ${names.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names to describe. Omit to get the whole catalogue. ' +
            `Known names: ${names.join(', ')}.`,
        },
      },
      additionalProperties: false,
    },

    async execute(input: { relations?: unknown }): Promise<ToolResult> {
      const requested = Array.isArray(input?.relations)
        ? (input.relations as unknown[]).filter(
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
        return {
          success: false,
          error: `No relation matched. Available: ${names.join(', ')}.`,
        };
      }

      return {
        success: true,
        data: {
          dialect: dialect.name,
          relations: selected.map(toRelationView),
          notice:
            'These are the only relations you can query. Use exactly these names and columns.',
        },
      };
    },
  };
}

/** Strips a descriptor down to what the model benefits from seeing. */
function toRelationView(relation: RelationDescriptor): RelationView {
  const view: RelationView = { name: relation.name };
  if (relation.description !== undefined) view.description = relation.description;
  if (relation.columns !== undefined) {
    view.columns = relation.columns.map((column) => {
      const out: RelationView['columns'] = [{ name: column.name }];
      const first = out[0];
      if (first !== undefined) {
        if (column.type !== undefined) first.type = column.type;
        if (column.description !== undefined) first.description = column.description;
      }
      return first ?? { name: column.name };
    });
  }
  return view;
}

/** Narrows the connection behind `handle` to a SQL one. */
function assertSqlConnection(handle: ConnectionHandle, toolName: string): SqlConnectionConfig {
  if (handle.config.type !== 'sql') {
    throw new ValidationError(
      `${toolName}.connection`,
      `connection '${handle.name}' is of type '${handle.config.type}'; sql.schema needs a sql connection`,
    );
  }
  return handle.config;
}
