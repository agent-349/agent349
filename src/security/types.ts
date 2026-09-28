/**
 * Security module types — ACL, middleware, sandboxing, sanitization, rate limiting.
 *
 * Types that are shared across modules (ACLPolicy, ACLDecision, FieldMaskRule,
 * DataFilterRule, ACLCondition) are canonically defined in `src/types/index.ts`
 * and re-exported here for intra-module convenience.
 *
 * Types that belong exclusively to this module are defined below.
 */

// ─────────────────────────────────────────────────────────────────────────────
// RE-EXPORTS FROM SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ACLPolicy,
  ACLCondition,
  ACLDecision,
  FieldMaskRule,
  DataFilterRule,
} from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecutionContext } from '../types/index.js';

/**
 * Discriminated payload passed to a middleware's `execute` method.
 * The `type` field identifies the pipeline stage; optional fields are populated
 * according to the stage (e.g. `toolName` is set for tool-related stages).
 */
export interface MiddlewarePayload {
  /** Pipeline stage at which this payload was produced. */
  type:
    | 'agent_start' // Before the agent loop begins
    | 'tool_call' // Before a tool executes
    | 'tool_result' // After a tool returns its result
    | 'rag_query' // Before a RAG search is issued
    | 'rag_result' // After a RAG search returns passages
    | 'agent_response'; // After the agent generates its final response

  /** Name of the tool involved (set for `tool_call` and `tool_result`). */
  toolName?: string;
  /**
   * Input data at this stage (e.g. tool input, RAG query string, user message).
   * Typed as `any` because the shape varies per stage.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  /**
   * Output data at this stage (e.g. tool result, RAG passages, agent text).
   * Typed as `any` because the shape varies per stage.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: any;
  /** Raw user message text (set for `agent_start`). */
  message?: string;
  /**
   * Structured content of the user turn, when it carries more than text
   * (images, documents). Set alongside `message`, which holds the flattened
   * text view middlewares reason over.
   *
   * A middleware that returns `blocks` in its `modifiedPayload` replaces the
   * whole turn; one that returns only `message` rewrites the text and leaves
   * every media block untouched.
   */
  blocks?: import('../types/index.js').ContentBlock[];
}

/**
 * A security observability event a middleware wants the chain to emit on the
 * EventBus. Keeping middlewares free of the bus keeps them pure and testable:
 * they *describe* what happened; the {@link SecurityMiddlewareChain} emits it
 * (enriched with the request's `_context`).
 */
export interface SecurityMiddlewareEvent {
  /** EventBus event name, e.g. `'security.acl.denied'`. */
  type: string;
  /** Event payload (correlation `_context` is added by the chain). */
  data: Record<string, unknown>;
}

/**
 * Decision returned by a middleware after processing a payload.
 * The chain stops immediately if any middleware returns `'block'`.
 * Returning `'modify'` replaces the payload for subsequent middlewares.
 */
export interface MiddlewareResult {
  /** What the chain should do after this middleware completes. */
  action: 'continue' | 'block' | 'modify';
  /** Human-readable explanation for a `'block'` decision (logged and audited). */
  reason?: string;
  /**
   * The modified payload to pass to the next middleware (only used when
   * `action` is `'modify'`).
   * Typed as `any` because the shape matches the current `MiddlewarePayload` fields.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modifiedPayload?: any;
  /**
   * Observability events to emit after this middleware runs, regardless of
   * `action`. Emitted by the chain only when it was given an EventBus.
   */
  events?: SecurityMiddlewareEvent[];
}

/**
 * Contract for a single security interceptor in the middleware chain.
 *
 * Middlewares are registered on a `SecurityMiddlewareChain` and executed in
 * ascending `priority` order. Lower numbers run first.
 *
 * Built-in middlewares and their default priorities:
 * - `RateLimiterMiddleware`    pre  priority 10
 * - `InputSanitizerMiddleware` pre  priority 20
 * - `ToolACLMiddleware`        pre  priority 30
 * - `DataFilterMiddleware`     post priority 40
 * - `FieldMaskMiddleware`      post priority 50
 */
export interface SecurityMiddleware {
  /** Unique name used in logs and audit records. */
  name: string;
  /** Whether this middleware runs before (`'pre'`) or after (`'post'`) execution. */
  phase: 'pre' | 'post';
  /** Execution order within its phase. Lower values run first. */
  priority: number;
  /** Which kind of operations this middleware intercepts. */
  appliesTo: 'agent' | 'tool' | 'rag' | 'all';
  /**
   * Inspect or modify the payload and decide whether to continue, block, or modify.
   *
   * @param context - Immutable execution context for the current request.
   * @param payload - Data describing the current pipeline stage.
   * @returns Decision on how the chain should proceed.
   */
  execute(context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL SANDBOXING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resource and isolation limits applied to tool executions.
 * A global config is set at startup; individual tools may override specific fields.
 */
export interface ToolSandboxConfig {
  // Per-execution limits
  /** Maximum wall-clock time allowed for a single tool call in ms. Default: 10 000. */
  maxExecutionTimeMs: number;
  /** Maximum retry attempts on transient failures. Default: 2. */
  maxRetries: number;
  /** Maximum size of the tool's output payload in bytes. Default: 1 048 576 (1 MB). */
  maxOutputSizeBytes: number;

  // Per-session limits
  /** Maximum total tool calls allowed within a single session. Default: 50. */
  maxCallsPerSession: number;
  /** Maximum calls to the same tool within a session. Default: 10. */
  maxCallsPerTool: number;

  // Per-tenant rate limits (rolling time windows)
  /** Maximum tool calls per minute across the entire tenant. Default: 100. */
  maxCallsPerMinute: number;
  /** Maximum tool calls per hour across the entire tenant. Default: 2 000. */
  maxCallsPerHour: number;

  // Isolation
  /** Whether tools are permitted to make outbound network requests. Default: true. */
  allowNetworkAccess: boolean;
  /** Whether tools are permitted to read or write the local filesystem. Default: false. */
  allowFileSystem: boolean;
  /**
   * Allowlist of domains that tools may contact when `allowNetworkAccess` is true.
   * Absent or empty means all domains are permitted.
   */
  allowedDomains?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT INJECTION DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single injection pattern detected within an input string.
 */
export interface DetectedPattern {
  /**
   * Category of the detected pattern.
   * Examples: `'role_override'`, `'instruction_inject'`,
   * `'delimiter_escape'`, `'context_manipulation'`.
   */
  type: string;
  /** The exact substring that triggered the detection. */
  match: string;
  /** Detection confidence score in [0, 1]. Higher means more certain. */
  confidence: number;
}

/**
 * Result of running `InputSanitizer.analyze()` on a user-supplied string.
 */
export interface SanitizationResult {
  /** Overall risk level of the input. */
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  /** All individual patterns detected within the input. */
  patterns: DetectedPattern[];
  /**
   * Recommended action based on the risk level and configured policy.
   * - `'allow'`    — safe to pass through unchanged
   * - `'sanitize'` — escape/remove dangerous patterns and continue
   * - `'block'`    — reject the input entirely
   */
  recommendation: 'allow' | 'sanitize' | 'block';
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by `RateLimiter.check()` or `RateLimiter.peek()`.
 */
export interface RateLimitResult {
  /** Whether the request is within the configured limit. */
  allowed: boolean;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Total limit for the current window. */
  limit: number;
  /** UTC timestamp when the current window resets and the counter returns to `limit`. */
  resetAt: Date;
}

/**
 * Rate limiting thresholds applied per tenant and per user.
 * Used when constructing a `RateLimiter` instance.
 */
export interface RateLimitConfig {
  /** Limits applied to a tenant as a whole (all users combined). */
  perTenant: {
    /** Maximum requests per minute. Default: 100. */
    perMinute: number;
    /** Maximum requests per hour. Default: 2 000. */
    perHour: number;
    /** Maximum requests per day. Default: 20 000. */
    perDay: number;
  };
  /** Limits applied to an individual user within a tenant. */
  perUser: {
    /** Maximum requests per minute. Default: 20. */
    perMinute: number;
    /** Maximum requests per hour. Default: 200. */
    perHour: number;
    /** Maximum requests per day. Default: 2 000. */
    perDay: number;
  };
}
