import { ValidationError } from '../../../errors/index.js';
import type { ConnectionHandle, HttpConnectionConfig } from '../../../connections/types.js';
import type { Credential } from '../../../credentials/types.js';
import type {
  ExecutionContext,
  JSONSchema,
  ResourceLimits,
  Tool,
  ToolResult,
  ValueBinding,
} from '../../../types/index.js';
import type { InternalToolContext } from '../../internalToolContext.js';
import { resolveBindings, validateBindings } from '../binding.js';
import type { BindingMap } from '../binding.js';
import { resolveLimits } from '../limits.js';
import { guardedRequest } from './guardedRequest.js';
import type { HttpTransportDeps } from './guardedRequest.js';

/** HTTP verbs a declared operation may use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** Verbs that change something on the other side. */
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Where a parameter goes in the request. */
export type HttpParamLocation = 'path' | 'query' | 'header';

/** A declared parameter: a {@link ValueBinding} plus where it belongs. */
export type HttpParamBinding = ValueBinding & { in: HttpParamLocation };

/** Request body of a declared operation. */
export interface HttpBodyConfig {
  /** Content type sent. Default `application/json`. */
  contentType?: string;
  /**
   * Body shape, with `:name` markers standing in for parameter values.
   * Markers are replaced **by value** after the template is cloned, never by
   * string splicing.
   */
  template?: unknown;
  /** Where the body's values come from. */
  params?: BindingMap;
}

/** How much of the response to hand back. */
export interface HttpResponseConfig {
  /**
   * Dot path to the part of a JSON response worth returning
   * (e.g. `data.items`). An endpoint that wraps everything in envelopes and
   * debug fields spends the model's context on noise.
   */
  pick?: string;
  /** Byte cap for the returned payload. */
  maxBytes?: number;
}

/** Configuration for {@link createHttpRequestTool}. */
export interface HttpRequestToolConfig {
  /** Tool name. Required when building programmatically. */
  name?: string;
  /** Name of the `http` connection this operation targets. */
  connection: string;
  /** The verb. Fixed by configuration — never chosen by the model. */
  method: HttpMethod;
  /** Path appended to the connection's `baseUrl`, with `{name}` placeholders. */
  path: string;
  /** Description sent to the LLM. */
  description?: string;
  /** Declared parameters, each with its location and origin. */
  params?: Record<string, HttpParamBinding>;
  /** Request body, for verbs that carry one. */
  body?: HttpBodyConfig;
  /** Response handling. */
  response?: HttpResponseConfig;
  /** Caps for this tool, lowered against the connection's. */
  limits?: ResourceLimits;
  /** Transport seams (request and DNS), injected in tests. */
  transport?: HttpTransportDeps;
}

/**
 * Builds an `http.request` tool: **one declared operation**, one fixed verb.
 *
 * The model never picks the host, the path or the method. It fills the
 * parameters marked `model` and nothing else. That is the whole difference
 * between this and a general-purpose fetch tool — and it is what keeps a
 * declared integration from turning into a server-side request forgery
 * primitive the moment a document tells the model to call somewhere else.
 *
 * One tool per operation, rather than one tool per verb, for two reasons: the
 * verb is a property of the operation and not a decision the model should be
 * making, and a catalogue of four generic tools tells the model nothing about
 * what the API can actually do.
 *
 * @param config - Tool configuration.
 * @param ctx    - Services injected by the SDK.
 * @returns The tool, ready to register.
 * @throws {@link ValidationError} for a malformed declaration.
 *
 * @example
 * ```jsonc
 * { "name": "crm.findCustomer", "kind": "internal", "ref": "http.request",
 *   "config": {
 *     "connection": "crm-api", "method": "GET", "path": "/customers/{id}",
 *     "params": { "id": { "in": "path", "from": "model",
 *                         "schema": { "type": "string" }, "required": true } }
 *   } }
 * ```
 */
export function createHttpRequestTool(
  config: HttpRequestToolConfig,
  ctx: InternalToolContext,
): Tool {
  const name = config.name ?? 'http.request';
  const handle = ctx.getConnection(config.connection);
  const connection = assertHttpConnection(handle, name);

  const params = config.params ?? {};
  validateBindings(stripLocations(params), `${name}.params`);
  for (const [param, binding] of Object.entries(params)) {
    if (!['path', 'query', 'header'].includes(binding.in)) {
      throw new ValidationError(
        `${name}.params.${param}.in`,
        `must be 'path', 'query' or 'header', got '${String(binding.in)}'`,
      );
    }
  }

  const bodyParams = config.body?.params ?? {};
  validateBindings(bodyParams, `${name}.body.params`);

  assertPathPlaceholders(config.path, params, name);

  const limits = resolveLimits(config.limits, connection.limits);
  const maxBytes = Math.min(config.response?.maxBytes ?? limits.maxBytes, limits.maxBytes);
  const mutating = MUTATING.has(config.method);

  // Dangerous but explicit: a mutating operation without approval is allowed —
  // some APIs use POST for search — but never silently.
  if (mutating) {
    ctx.emit('security.http.mutating.unapproved', {
      toolName: name,
      connection: handle.name,
      method: config.method,
      reason:
        `'${config.method} ${config.path}' changes state on the other side. Set ` +
        'requiresApproval on the tool definition unless this verb is being used ' +
        'for a read.',
    });
  }

  const tool: Tool = {
    name,
    description: config.description ?? `Calls ${config.method} ${config.path} on '${handle.name}'.`,
    inputSchema: buildHttpInputSchema(params, bodyParams),
    ...(mutating && { sideEffects: true }),
    async execute(input: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
      const values = resolveBindings(stripLocations(params), input ?? {}, context);
      const bodyValues = resolveBindings(bodyParams, input ?? {}, context);

      const url = buildUrl(connection.baseUrl, config.path, params, values, name);
      const headers = buildHeaders(connection, params, values);
      const credential = await handle.credential(context);
      applyCredential(headers, credential);

      let payload: string | undefined;
      if (config.body?.template !== undefined) {
        const contentType = config.body.contentType ?? 'application/json';
        headers['content-type'] = contentType;
        payload = JSON.stringify(fillTemplate(config.body.template, bodyValues));
      }

      const response = await guardedRequest(
        {
          url,
          method: config.method,
          headers,
          ...(payload !== undefined && { body: payload }),
          timeoutMs: limits.timeoutMs,
          maxBytes,
          allowedHosts: allowedHostsFor(connection),
          // The destination is fixed by configuration, and an internal service
          // is a legitimate target for a declared integration — unless the
          // connection says it was declared by someone other than the
          // integrator, in which case the full address chain applies.
          blockPrivateAddresses: connection.blockPrivateAddresses === true,
          followRedirects: connection.followRedirects ?? false,
          ...(connection.maxRedirects !== undefined && { maxRedirects: connection.maxRedirects }),
        },
        config.transport,
      );

      return shapeResponse(response, config.response?.pick);
    },
  };

  return tool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the request
// ─────────────────────────────────────────────────────────────────────────────

/** Assembles the target URL, refusing any value that tries to leave the host. */
function buildUrl(
  baseUrl: string,
  pathTemplate: string,
  params: Record<string, HttpParamBinding>,
  values: Record<string, unknown>,
  toolName: string,
): string {
  const path = pathTemplate.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const raw = values[key];
    if (raw === undefined) {
      throw new ValidationError(`${toolName}.path`, `no value for path parameter '{${key}}'`);
    }
    const value = toParamString(raw, `${toolName}.path`, key);

    // Without these two checks a path parameter is a way out of the declared
    // endpoint: '../../admin' walks the path, and an absolute URL replaces the
    // host outright.
    if (value.includes('..')) {
      throw new ValidationError(`${toolName}.path`, `path parameter '${key}' may not contain '..'`);
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new ValidationError(
        `${toolName}.path`,
        `path parameter '${key}' may not be an absolute URL`,
      );
    }
    return encodeURIComponent(value);
  });

  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);

  for (const [key, binding] of Object.entries(params)) {
    if (binding.in !== 'query') continue;
    const value = values[key];
    if (value === undefined) continue;
    url.searchParams.set(key, toParamString(value, `${toolName}.params`, key));
  }

  return url.toString();
}

/**
 * Renders a parameter value as the string that goes into a URL or a header.
 *
 * Objects and arrays are refused rather than stringified: `[object Object]` in
 * a path is a bug that produces a confusing 404 instead of an error anyone can
 * read.
 */
function toParamString(value: unknown, field: string, key: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new ValidationError(
    field,
    `parameter '${key}' must be a string, number or boolean, got ${typeof value}`,
  );
}

/** Merges connection headers with the ones declared on the operation. */
function buildHeaders(
  connection: HttpConnectionConfig,
  params: Record<string, HttpParamBinding>,
  values: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };

  for (const [key, value] of Object.entries(connection.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  for (const [key, binding] of Object.entries(params)) {
    if (binding.in !== 'header') continue;
    const value = values[key];
    if (value !== undefined) headers[key.toLowerCase()] = toParamString(value, 'header', key);
  }

  return headers;
}

/** Turns a resolved credential into the header it belongs in. */
export function applyCredential(headers: Record<string, string>, credential: Credential): void {
  switch (credential.kind) {
    case 'bearer':
      headers['authorization'] = `Bearer ${credential.token}`;
      break;
    case 'basic':
      headers['authorization'] =
        `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
      break;
    case 'apiKey':
      headers[credential.header.toLowerCase()] = credential.value;
      break;
    case 'none':
    case 'custom':
      break;
  }
}

/** Replaces `:name` markers in a body template with resolved values. */
export function fillTemplate(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const marker = /^:([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(template);
    // Whole-string markers are substituted by value, so a number stays a
    // number and an object stays an object instead of being stringified.
    return marker?.[1] !== undefined ? (values[marker[1]] ?? null) : template;
  }
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values));
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      out[key] = fillTemplate(value, values);
    }
    return out;
  }
  return template;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shaping the response
// ─────────────────────────────────────────────────────────────────────────────

/** Turns a raw response into the tool result the model sees. */
function shapeResponse(
  response: { status: number; body: string; truncated: boolean; finalUrl: string },
  pick: string | undefined,
): ToolResult {
  const parsed = tryParseJson(response.body);

  if (response.status < 200 || response.status >= 300) {
    // Not an exception: an HTTP error is information the model can act on, and
    // failing the whole loop over a 404 helps nobody.
    return {
      success: false,
      error:
        `The request failed with HTTP ${response.status}. ` +
        `Response: ${truncateForMessage(response.body)}`,
    };
  }

  const payload = pick !== undefined && parsed !== undefined ? pickPath(parsed, pick) : parsed;

  return {
    success: true,
    data: {
      status: response.status,
      body: payload ?? response.body,
      ...(response.truncated && {
        truncated: true,
        notice: 'Truncated: the response exceeded the configured size limit and was cut short.',
      }),
    },
  };
}

/** Parses a JSON body, or returns `undefined` when it is not JSON. */
function tryParseJson(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Walks a dot path into a parsed body. */
export function pickPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Trims a body down to something reasonable to put in an error message. */
function truncateForMessage(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Declaration checks
// ─────────────────────────────────────────────────────────────────────────────

/** Drops the `in` field, leaving plain bindings the shared helpers understand. */
function stripLocations(params: Record<string, HttpParamBinding>): BindingMap {
  const out: BindingMap = {};
  for (const [key, binding] of Object.entries(params)) {
    const { in: _location, ...rest } = binding;
    out[key] = rest as ValueBinding;
  }
  return out;
}

/** Publishes the model-supplied parameters from both the request and the body. */
function buildHttpInputSchema(
  params: Record<string, HttpParamBinding>,
  bodyParams: BindingMap,
): JSONSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const collect = (bindings: BindingMap): void => {
    for (const [key, binding] of Object.entries(bindings)) {
      if (binding.from !== 'model') continue;
      properties[key] =
        binding.description === undefined
          ? binding.schema
          : { ...binding.schema, description: binding.description };
      if (binding.required === true) required.push(key);
    }
  };

  collect(stripLocations(params));
  collect(bodyParams);

  const schema: JSONSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

/** Fails at load time when the path names a parameter that is not declared. */
function assertPathPlaceholders(
  path: string,
  params: Record<string, HttpParamBinding>,
  toolName: string,
): void {
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const key = match[1];
    if (key === undefined) continue;
    const binding = params[key];
    if (binding === undefined) {
      throw new ValidationError(
        `${toolName}.path`,
        `the path uses '{${key}}' but no parameter declares where its value comes from`,
      );
    }
    if (binding.in !== 'path') {
      throw new ValidationError(
        `${toolName}.params.${key}.in`,
        `'${key}' appears in the path, so it must be declared with "in": "path"`,
      );
    }
  }
}

/** Hosts reachable for this connection: its own, plus any extras declared. */
function allowedHostsFor(connection: HttpConnectionConfig): string[] {
  const base = new URL(connection.baseUrl).hostname;
  return [base, ...(connection.allowedHosts ?? [])];
}

/** Narrows the connection behind `handle` to an HTTP one. */
function assertHttpConnection(handle: ConnectionHandle, toolName: string): HttpConnectionConfig {
  if (handle.config.type !== 'http') {
    throw new ValidationError(
      `${toolName}.connection`,
      `connection '${handle.name}' is of type '${handle.config.type}'; http.request needs an http connection`,
    );
  }
  return handle.config;
}
