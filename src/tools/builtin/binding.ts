import { ValidationError } from '../../errors/index.js';
import type { ContextPath, ExecutionContext, JSONSchema, ValueBinding } from '../../types/index.js';

/** A tool's parameters, keyed by the name each one binds to. */
export type BindingMap = Record<string, ValueBinding>;

/** Resolved parameter values, keyed the same way as the {@link BindingMap}. */
export type BoundValues = Record<string, unknown>;

/**
 * Builds the `inputSchema` published to the LLM from a {@link BindingMap}.
 *
 * Only `model` bindings appear. `context` and `literal` values are not
 * filtered out of the model's answer afterwards — they are never offered, so
 * the model has no way to name them, let alone override them. That is the
 * whole point of the binding vocabulary.
 *
 * @param bindings - The tool's declared parameters.
 * @returns A JSON Schema object describing exactly the model-supplied fields.
 *
 * @example
 * ```typescript
 * buildInputSchema({
 *   clientId: { from: 'context', path: 'metadata.clientId' },
 *   from:     { from: 'model', schema: { type: 'string' }, required: true },
 * });
 * // → { type: 'object', properties: { from: { type: 'string' } },
 * //     required: ['from'], additionalProperties: false }
 * ```
 */
export function buildInputSchema(bindings: BindingMap): JSONSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.from !== 'model') continue;
    properties[name] =
      binding.description === undefined
        ? binding.schema
        : { ...binding.schema, description: binding.description };
    if (binding.required === true) required.push(name);
  }

  const schema: JSONSchema = {
    type: 'object',
    properties,
    // Closed by construction: a model that invents an extra field is rejected
    // by the executor's AJV pass rather than having it silently ignored.
    additionalProperties: false,
  };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

/**
 * Resolves every declared parameter to its value for one execution.
 *
 * Model inputs are read from `input` (already schema-validated by the
 * `ToolExecutor`); context bindings are read from `context`; literals come
 * from the declaration.
 *
 * @param bindings - The tool's declared parameters.
 * @param input    - The LLM-supplied input object.
 * @param context  - The execution context.
 * @returns Every declared name mapped to its resolved value. Names whose
 *          optional binding produced nothing are absent, not `undefined`.
 * @throws {@link ValidationError} when a `required` binding has no value.
 *         Failing loudly is deliberate: the quiet alternative is a query that
 *         runs unscoped.
 */
export function resolveBindings(
  bindings: BindingMap,
  input: Record<string, unknown>,
  context: ExecutionContext,
): BoundValues {
  const values: BoundValues = {};

  for (const [name, binding] of Object.entries(bindings)) {
    switch (binding.from) {
      case 'literal':
        values[name] = binding.value;
        break;

      case 'model': {
        const value = input[name];
        if (value === undefined) {
          if (binding.required === true) {
            throw new ValidationError(name, `required parameter '${name}' was not supplied`);
          }
          break;
        }
        values[name] = value;
        break;
      }

      case 'context': {
        const value = readContextPath(context, binding.path);
        if (value === undefined || value === null || value === '') {
          if (binding.required === true) {
            throw new ValidationError(
              name,
              `parameter '${name}' binds to context path '${binding.path}', ` +
                'which carries no value in this execution',
            );
          }
          break;
        }
        values[name] = value;
        break;
      }
    }
  }

  return values;
}

/**
 * Reads a {@link ContextPath} off an {@link ExecutionContext}.
 *
 * The SDK transports these values without interpreting them: what
 * `metadata.employeeId` means is the integrator's business.
 *
 * @param context - The execution context to read from.
 * @param path    - `'userId'`, `'roles'`, … or `'metadata.<key>'`.
 * @returns The value, or `undefined` when absent.
 */
export function readContextPath(context: ExecutionContext, path: ContextPath): unknown {
  if (path.startsWith('metadata.')) {
    const key = path.slice('metadata.'.length);
    return context.metadata?.[key];
  }
  switch (path) {
    case 'userId':
      return context.userId;
    case 'tenantId':
      return context.tenantId;
    case 'sessionId':
      return context.sessionId;
    case 'agentId':
      return context.agentId;
    case 'roles':
      return context.roles;
    default:
      return undefined;
  }
}

/**
 * Validates a {@link BindingMap} at load time, so a malformed declaration
 * fails when the config is read rather than when an agent first calls the tool.
 *
 * @param bindings - The declared parameters.
 * @param path     - Config path used in error messages (e.g. `'ventas.porCliente.params'`).
 * @throws {@link ValidationError} on an unknown `from`, a `model` binding with
 *         no schema, or a `context` binding with an unreadable path.
 */
export function validateBindings(bindings: BindingMap, path: string): void {
  for (const [name, binding] of Object.entries(bindings)) {
    const field = `${path}.${name}`;

    if (binding === null || typeof binding !== 'object' || !('from' in binding)) {
      throw new ValidationError(field, `binding '${name}' must declare a 'from' field`);
    }

    switch (binding.from) {
      case 'model':
        if (binding.schema === undefined || typeof binding.schema !== 'object') {
          throw new ValidationError(
            field,
            `binding '${name}' is model-supplied and must declare a JSON Schema`,
          );
        }
        break;

      case 'context':
        if (!isContextPath(binding.path)) {
          throw new ValidationError(
            field,
            `binding '${name}' declares an unreadable context path '${String(binding.path)}'. ` +
              "Use userId, tenantId, sessionId, agentId, roles, or 'metadata.<key>'",
          );
        }
        break;

      case 'literal':
        break;

      default:
        throw new ValidationError(
          field,
          `binding '${name}' has unknown origin '${String((binding as { from: unknown }).from)}'. ` +
            'Use model, context, or literal',
        );
    }
  }
}

/** Whether `value` is a readable {@link ContextPath}. */
function isContextPath(value: unknown): value is ContextPath {
  if (typeof value !== 'string') return false;
  if (value.startsWith('metadata.')) return value.length > 'metadata.'.length;
  return ['userId', 'tenantId', 'sessionId', 'agentId', 'roles'].includes(value);
}
