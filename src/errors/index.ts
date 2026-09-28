/**
 * Custom error classes for the Agent Orchestration SDK.
 *
 * All errors extend `SDKError`, which in turn extends the native `Error`.
 * This allows standard `instanceof` checks at every level of the hierarchy.
 *
 * Conventions:
 * - Each class declares a `readonly name` that matches the class name.
 * - Each class declares a `readonly code` string usable for programmatic matching
 *   without relying on `instanceof` (useful across module boundaries).
 * - Extra context fields are `readonly` and set in the constructor.
 * - The native `cause` option is forwarded to `super()` when an upstream error
 *   is available, preserving the full error chain.
 */

// ─────────────────────────────────────────────────────────────────────────────
// BASE — re-exported from its own file to break circular dependency with
//         RAGError (which also extends SDKError).
// ─────────────────────────────────────────────────────────────────────────────

import { SDKError } from './SDKError.js';
export { SDKError } from './SDKError.js';

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS CONTROL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a user attempts to access a resource they are not permitted to use.
 * Produced by the ACL service and the security middleware chain.
 */
export class AccessDeniedError extends SDKError {
  override readonly name = 'AccessDeniedError';

  /** Type of resource that was blocked (e.g. `'tool'`, `'skill'`, `'agent'`). */
  readonly resourceType: string;
  /** Identifier of the blocked resource (e.g. `'finance.getBalance'`). */
  readonly resourceId: string;
  /** Roles the user held at the time of the check. */
  readonly userRoles: string[];

  /**
   * @param resourceType - Category of the resource (tool, skill, agent…).
   * @param resourceId   - Specific resource identifier.
   * @param userRoles    - Roles the user had when the check was made.
   * @param options      - Standard `ErrorOptions`.
   */
  constructor(
    resourceType: string,
    resourceId: string,
    userRoles: string[],
    options?: ErrorOptions,
  ) {
    super(
      `Access denied to ${resourceType} '${resourceId}' for roles [${userRoles.join(', ')}]`,
      'ACCESS_DENIED',
      options,
    );
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    this.userRoles = userRoles;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL ERRORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a tool name is resolved but no matching registration exists in the
 * `ToolRegistry`. Typically indicates a misconfigured agent or skill definition.
 */
export class ToolNotFoundError extends SDKError {
  override readonly name = 'ToolNotFoundError';

  /** The tool name that was not found in the registry. */
  readonly toolName: string;

  /**
   * @param toolName - Name of the unregistered tool.
   * @param options  - Standard `ErrorOptions`.
   */
  constructor(toolName: string, options?: ErrorOptions) {
    super(`Tool '${toolName}' is not registered`, 'TOOL_NOT_FOUND', options);
    this.toolName = toolName;
  }
}

/**
 * Thrown when a tool's execution exceeds its configured timeout.
 * The `ToolExecutor` cancels the pending promise and throws this error.
 */
export class ToolTimeoutError extends SDKError {
  override readonly name = 'ToolTimeoutError';

  /** The tool that timed out. */
  readonly toolName: string;
  /** The timeout threshold that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * @param toolName  - Name of the tool that timed out.
   * @param timeoutMs - Configured timeout in milliseconds.
   * @param options   - Standard `ErrorOptions`.
   */
  constructor(toolName: string, timeoutMs: number, options?: ErrorOptions) {
    super(`Tool '${toolName}' exceeded timeout of ${timeoutMs} ms`, 'TOOL_TIMEOUT', options);
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a tool's `execute()` method throws an unexpected error that is
 * not covered by the retry policy. Wraps the original error as `cause`.
 */
export class ToolExecutionError extends SDKError {
  override readonly name = 'ToolExecutionError';

  /** The tool whose execution failed. */
  readonly toolName: string;
  /** The attempt number on which the final failure occurred (1-based). */
  readonly attempt: number;

  /**
   * @param toolName - Name of the tool that failed.
   * @param attempt  - Attempt number that ultimately failed.
   * @param cause    - The underlying error thrown by the tool.
   */
  constructor(toolName: string, attempt: number, cause: unknown) {
    const message =
      cause instanceof Error
        ? `Tool '${toolName}' failed on attempt ${attempt}: ${cause.message}`
        : `Tool '${toolName}' failed on attempt ${attempt}`;
    super(message, 'TOOL_EXECUTION_ERROR', { cause: cause instanceof Error ? cause : undefined });
    this.toolName = toolName;
    this.attempt = attempt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when the agent loop reaches `AgentConfig.maxLoopIterations` without
 * producing a final response. Usually indicates a runaway tool-calling cycle.
 */
export class MaxIterationsError extends SDKError {
  override readonly name = 'MaxIterationsError';

  /** The iteration ceiling that was hit. */
  readonly maxIterations: number;

  /**
   * @param maxIterations - The configured maximum that was reached.
   * @param options       - Standard `ErrorOptions`.
   */
  constructor(maxIterations: number, options?: ErrorOptions) {
    super(
      `Agent loop reached the maximum of ${maxIterations} iterations without a final response`,
      'MAX_ITERATIONS',
      options,
    );
    this.maxIterations = maxIterations;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the `ConfigLoader` when the configuration file is missing, malformed,
 * or contains an invalid value for a required field.
 */
export class ConfigError extends SDKError {
  override readonly name = 'ConfigError';

  /**
   * Dot-notation path of the configuration key that caused the error
   * (e.g. `'llm.providers.claude.apiKey'`). Absent when the error is not
   * field-specific (e.g. file not found).
   */
  readonly field?: string;

  /**
   * @param message - Description of the configuration problem.
   * @param field   - Optional dot-notation path of the invalid field.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(message, 'CONFIG_ERROR', options);
    if (field !== undefined) {
      this.field = field;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DECLARATIVE CONFIG LOADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a declarative tool's module specifier cannot be resolved to an
 * importable path — for example a relative path that escapes the configured
 * `moduleRoots` allowlist, or an unresolved `${ENV_VAR}` placeholder.
 */
export class ModuleResolutionError extends SDKError {
  override readonly name = 'ModuleResolutionError';

  /** The raw module specifier that failed to resolve. */
  readonly specifier: string;

  /**
   * @param specifier - The module specifier from the tool definition.
   * @param reason    - Human-readable reason the specifier was rejected.
   * @param options   - Standard `ErrorOptions`.
   */
  constructor(specifier: string, reason: string, options?: ErrorOptions) {
    super(`Cannot resolve module '${specifier}': ${reason}`, 'MODULE_RESOLUTION_ERROR', options);
    this.specifier = specifier;
  }
}

/**
 * Thrown when a declaratively-configured tool cannot be built: the module
 * import fails, the named export is missing, the internal `ref` is unknown,
 * or the resolved value is not a valid {@link import('../types/index.js').Tool}.
 * Wraps the underlying error as `cause` when available.
 */
export class ToolLoadError extends SDKError {
  override readonly name = 'ToolLoadError';

  /** Name of the tool definition that failed to load. */
  readonly toolName: string;
  /** Module specifier or internal `ref` that was being loaded (if known). */
  readonly source?: string;

  /**
   * @param toolName - The `name` of the failing tool definition.
   * @param reason   - Human-readable description of the failure.
   * @param source   - Module specifier or internal ref involved (optional).
   * @param options  - Standard `ErrorOptions` (forward the original `cause`).
   */
  constructor(toolName: string, reason: string, source?: string, options?: ErrorOptions) {
    super(
      `Failed to load tool '${toolName}'${source !== undefined ? ` from '${source}'` : ''}: ${reason}`,
      'TOOL_LOAD_ERROR',
      options,
    );
    this.toolName = toolName;
    if (source !== undefined) {
      this.source = source;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when an MCP server cannot be reached, the handshake fails, or the
 * `@modelcontextprotocol/sdk` optional dependency is not installed.
 *
 * Raised by `McpClient.connect()` and by any operation attempted on a client
 * that is closed or was never connected.
 */
export class McpConnectionError extends SDKError {
  override readonly name = 'McpConnectionError';

  /** Logical name of the MCP server, as declared in the SDK config. */
  readonly serverName: string;

  /**
   * @param serverName - Logical name of the server that failed.
   * @param reason     - Human-readable description of the failure.
   * @param options    - Standard `ErrorOptions` (forward the original `cause`).
   */
  constructor(serverName: string, reason: string, options?: ErrorOptions) {
    super(`MCP server '${serverName}': ${reason}`, 'MCP_CONNECTION_ERROR', options);
    this.serverName = serverName;
  }
}

/**
 * Thrown when an MCP tool invocation fails at the protocol level — the server
 * returns a JSON-RPC error, the request times out, or the named tool is not
 * exposed by the server.
 *
 * Note this is **not** used for tools that execute successfully but report a
 * failure via `isError: true`. Those are mapped to a failed `ToolResult` so the
 * agent loop can feed the message back to the LLM.
 */
export class McpToolError extends SDKError {
  override readonly name = 'McpToolError';

  /** Logical name of the MCP server that owns the tool. */
  readonly serverName: string;
  /** Tool name as exposed by the remote server (not the namespaced SDK name). */
  readonly remoteName: string;

  /**
   * @param serverName - Logical name of the server.
   * @param remoteName - Remote tool name that failed.
   * @param reason     - Human-readable description of the failure.
   * @param options    - Standard `ErrorOptions` (forward the original `cause`).
   */
  constructor(serverName: string, remoteName: string, reason: string, options?: ErrorOptions) {
    super(
      `MCP tool '${remoteName}' on server '${serverName}': ${reason}`,
      'MCP_TOOL_ERROR',
      options,
    );
    this.serverName = serverName;
    this.remoteName = remoteName;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM / EMBEDDING PROVIDERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when an LLM or embedding provider returns an error response, is
 * unreachable, or fails authentication. Used by all provider implementations
 * (`ClaudeProvider`, `OpenAIProvider`, `OllamaProvider`, etc.).
 */
export class ProviderError extends SDKError {
  override readonly name = 'ProviderError';

  /** Name of the provider that failed (e.g. `'claude'`, `'openai'`). */
  readonly provider: string;
  /** Model identifier that was requested (if known). */
  readonly model?: string;
  /**
   * HTTP status code returned by the provider's API (if applicable).
   * Useful for distinguishing auth errors (401) from quota errors (429).
   */
  readonly statusCode?: number;

  /**
   * @param provider   - Provider name.
   * @param message    - Error description from the provider response.
   * @param model      - Model that was requested.
   * @param statusCode - HTTP status from the provider API.
   * @param options    - Standard `ErrorOptions`.
   */
  constructor(
    provider: string,
    message: string,
    model?: string,
    statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(`Provider '${provider}' error: ${message}`, 'PROVIDER_ERROR', options);
    this.provider = provider;
    if (model !== undefined) {
      this.model = model;
    }
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
  }
}

/**
 * Thrown when a request needs a capability the target provider or model does
 * not have — a document sent to a text-only model, a JSON Schema asked of a
 * provider without native structured output, a provider file reference reused
 * across providers, or a URL source a provider will not fetch.
 *
 * The SDK never silently drops unsupported content: it fails here instead, so
 * a truncated prompt can never reach the model unnoticed.
 */
export class UnsupportedCapabilityError extends SDKError {
  override readonly name = 'UnsupportedCapabilityError';

  /** Provider instance that cannot serve the request. */
  readonly provider: string;
  /** Capability that is missing (e.g. `'input.document'`, `'structuredOutput'`). */
  readonly capability: string;
  /** Model the capability was checked against (if known). */
  readonly model?: string;

  /**
   * @param provider   - Provider instance name.
   * @param capability - Missing capability identifier.
   * @param detail     - Human-readable explanation, ideally with a way forward.
   * @param model      - Model that was requested.
   * @param options    - Standard `ErrorOptions`.
   */
  constructor(
    provider: string,
    capability: string,
    detail: string,
    model?: string,
    options?: ErrorOptions,
  ) {
    super(
      `Provider '${provider}' does not support '${capability}': ${detail}`,
      'UNSUPPORTED_CAPABILITY',
      options,
    );
    this.provider = provider;
    this.capability = capability;
    if (model !== undefined) {
      this.model = model;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the `RateLimiter` middleware when a tenant or user exceeds their
 * configured request quota. The caller should communicate `resetAt` to the
 * end user so they know when to retry.
 */
export class RateLimitError extends SDKError {
  override readonly name = 'RateLimitError';

  /** Tenant whose limit was exceeded. */
  readonly tenantId: string;
  /** User whose limit was exceeded (absent when the limit is tenant-wide). */
  readonly userId?: string;
  /** UTC timestamp when the rate-limit window resets and requests are allowed again. */
  readonly resetAt: Date;
  /** The request quota for the current window. */
  readonly limit: number;
  /** Requests remaining in the current window at the time of the error (always 0). */
  readonly remaining: number;

  /**
   * @param tenantId  - Tenant that hit the limit.
   * @param resetAt   - When the window resets.
   * @param limit     - Configured request ceiling.
   * @param userId    - User that hit the limit (optional; omit for tenant-level limits).
   * @param options   - Standard `ErrorOptions`.
   */
  constructor(
    tenantId: string,
    resetAt: Date,
    limit: number,
    userId?: string,
    options?: ErrorOptions,
  ) {
    const subject = userId ? `user '${userId}' in tenant '${tenantId}'` : `tenant '${tenantId}'`;
    super(
      `Rate limit of ${limit} requests exceeded for ${subject}. Resets at ${resetAt.toISOString()}`,
      'RATE_LIMIT',
      options,
    );
    this.tenantId = tenantId;
    if (userId !== undefined) {
      this.userId = userId;
    }
    this.resetAt = resetAt;
    this.limit = limit;
    this.remaining = 0;
  }
}

/**
 * Thrown when governed LLM token usage would exceed a configured budget.
 * Unlike request-rate limits, this error identifies token scope and window.
 */
export class TokenLimitError extends SDKError {
  override readonly name = 'TokenLimitError';
  readonly tenantId: string;
  readonly userId?: string;
  readonly scope: 'tenant' | 'user';
  readonly window: 'daily' | 'monthly';
  readonly used: number;
  readonly projected: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;

  constructor(
    tenantId: string,
    detail: {
      scope: 'tenant' | 'user';
      window: 'daily' | 'monthly';
      used: number;
      projected: number;
      limit: number;
      remaining: number;
      resetAt: Date;
    },
    userId?: string,
    options?: ErrorOptions,
  ) {
    super(
      `Token ${detail.window} limit of ${detail.limit} exceeded for ${detail.scope} ` +
        `(used ${detail.used}, projected ${detail.projected}). Resets at ${detail.resetAt.toISOString()}`,
      'TOKEN_LIMIT',
      options,
    );
    this.tenantId = tenantId;
    if (userId !== undefined) this.userId = userId;
    this.scope = detail.scope;
    this.window = detail.window;
    this.used = detail.used;
    this.projected = detail.projected;
    this.limit = detail.limit;
    this.remaining = detail.remaining;
    this.resetAt = detail.resetAt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HUMAN-IN-THE-LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown (or returned as a structured response) when the agent loop encounters
 * a tool that requires human approval before execution. The `actionId` can be
 * used by the caller to query the approval status via `ApprovalService`.
 */
export class ApprovalRequiredError extends SDKError {
  override readonly name = 'ApprovalRequiredError';

  /** Tool whose execution has been deferred for approval. */
  readonly toolName: string;
  /** Identifier of the `PendingAction` created for this approval request. */
  readonly actionId: string;

  /**
   * @param toolName - Tool that requires approval.
   * @param actionId - ID of the created `PendingAction`.
   * @param options  - Standard `ErrorOptions`.
   */
  constructor(toolName: string, actionId: string, options?: ErrorOptions) {
    super(
      `Tool '${toolName}' requires human approval (action id: ${actionId})`,
      'APPROVAL_REQUIRED',
      options,
    );
    this.toolName = toolName;
    this.actionId = actionId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG
// ─────────────────────────────────────────────────────────────────────────────

export { RAGError } from './RAGError.js';
export { RerankerError } from './RerankerError.js';
export type { RerankerFailureStage } from './RerankerError.js';

// ─────────────────────────────────────────────────────────────────────────────
// PLANNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by the `Planner` when the LLM response cannot be parsed into a valid
 * execution plan. Typically caused by a model that ignored the JSON-only
 * instruction or returned a structurally invalid object.
 */
export class PlannerError extends SDKError {
  override readonly name = 'PlannerError';

  /**
   * @param message - Description of the parse or validation failure.
   * @param options - Standard `ErrorOptions` (use `cause` to wrap the parse error).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PLANNER_ERROR', options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when an input value fails schema or business-rule validation.
 * Used by the `ToolExecutor` (input schema check), `ConfigLoader`, and any
 * component that validates data at a system boundary.
 */
export class ValidationError extends SDKError {
  override readonly name = 'ValidationError';

  /**
   * Dot-notation path of the field that failed validation
   * (e.g. `'input.accountId'`, `'llm.temperature'`).
   */
  readonly field: string;
  /**
   * The value that was rejected.
   * Typed as `unknown` so callers are forced to narrow before using it.
   */
  readonly value: unknown;

  /**
   * @param field   - Dot-notation path of the invalid field.
   * @param message - Human-readable explanation of the validation failure.
   * @param value   - The value that was rejected.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(field: string, message: string, value?: unknown, options?: ErrorOptions) {
    super(message, 'VALIDATION_ERROR', options);
    this.field = field;
    this.value = value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION TOOLS — CONNECTIONS, CREDENTIALS, EGRESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when a declared connection cannot be opened or used: no driver
 * registered for its type, the backing service is unreachable, or the handle
 * was used after `close()`.
 */
export class ConnectionError extends SDKError {
  override readonly name = 'ConnectionError';

  /** Name of the connection, as keyed in the `connections` config section. */
  readonly connection: string;

  /**
   * @param connection - Name of the connection that failed.
   * @param message    - Human-readable description of the failure.
   * @param options    - Standard `ErrorOptions` (use `cause` to wrap the driver error).
   */
  constructor(connection: string, message: string, options?: ErrorOptions) {
    super(`connection '${connection}': ${message}`, 'CONNECTION_ERROR', options);
    this.connection = connection;
  }
}

/**
 * Thrown when a {@link import('../credentials/index.js').CredentialProvider}
 * cannot resolve a reference — unknown ref, expired grant, or an upstream
 * failure while refreshing.
 *
 * The message must never carry the credential material itself.
 */
export class CredentialError extends SDKError {
  override readonly name = 'CredentialError';

  /** The unresolvable credential reference. */
  readonly ref: string;

  /**
   * @param ref     - Credential reference that could not be resolved.
   * @param message - Human-readable reason. Must not include secret material.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(ref: string, message: string, options?: ErrorOptions) {
    super(`credential '${ref}': ${message}`, 'CREDENTIAL_ERROR', options);
    this.ref = ref;
  }
}

/**
 * Thrown when a model-authored query is rejected before execution — a
 * non-read statement, a relation outside the allowlist, stacked statements.
 *
 * Carries `control` so the caller (and the `tool.query.rejected` event) can
 * report *which* guard fired rather than a generic refusal.
 *
 * These guards are defence in depth, not the security boundary: the guarantee
 * is a read-only database user with permissions scoped to the exposed
 * relations.
 */
export class QueryRejectedError extends SDKError {
  override readonly name = 'QueryRejectedError';

  /** Identifier of the guard that rejected the query (e.g. `'read-only'`). */
  readonly control: string;

  /**
   * @param control - Guard that rejected the query.
   * @param message - Explanation, phrased so a model can correct and retry.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(control: string, message: string, options?: ErrorOptions) {
    super(message, 'QUERY_REJECTED', options);
    this.control = control;
  }
}

/**
 * Thrown when an outbound destination is refused: a host outside the
 * allowlist, a URL resolving to a private or link-local address, a redirect
 * leaving the permitted set, or a mail recipient in a disallowed domain.
 */
export class EgressDeniedError extends SDKError {
  override readonly name = 'EgressDeniedError';

  /** The refused destination (host, URL, or recipient address). */
  readonly destination: string;
  /** Identifier of the control that refused it (e.g. `'private-ip'`). */
  readonly control: string;

  /**
   * @param destination - The refused destination.
   * @param control     - Control that refused it.
   * @param message     - Human-readable explanation.
   * @param options     - Standard `ErrorOptions`.
   */
  constructor(destination: string, control: string, message: string, options?: ErrorOptions) {
    super(message, 'EGRESS_DENIED', options);
    this.destination = destination;
    this.control = control;
  }
}

/**
 * Thrown when a hard resource cap is exceeded and truncation is not an option
 * — for instance an input larger than the configured ceiling.
 *
 * Caps that *can* be honoured by cutting the result short do not throw: they
 * truncate and flag it in the {@link import('../types/index.js').CollectionResult}
 * envelope instead.
 */
export class ResourceLimitError extends SDKError {
  override readonly name = 'ResourceLimitError';

  /** Which limit was exceeded (e.g. `'maxBytes'`). */
  readonly limit: string;

  /**
   * @param limit   - Name of the exceeded limit.
   * @param message - Human-readable explanation including the configured cap.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(limit: string, message: string, options?: ErrorOptions) {
    super(message, 'RESOURCE_LIMIT', options);
    this.limit = limit;
  }
}
