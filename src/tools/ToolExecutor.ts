import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ToolNotFoundError, ToolTimeoutError } from '../errors/index.js';
import type { EventBus } from '../events/EventBus.js';
import type {
  ExecutionContext,
  JSONSchema,
  RetryPolicy,
  Tool,
  ToolResult,
} from '../types/index.js';
import type { ToolRegistry } from './ToolRegistry.js';
import type { UntrustedTracker } from '../security/UntrustedTracker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & public types
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_RETRY_POLICY: ResolvedPolicy = {
  maxRetries: 2,
  backoffMs: 1_000,
  backoffMultiplier: 2,
  retryableErrors: [],
};

/** A {@link RetryPolicy} with every field guaranteed to be present. */
type ResolvedPolicy = Required<RetryPolicy>;

/** Constructor options for {@link ToolExecutor}. */
export interface ToolExecutorOptions {
  /**
   * Fallback timeout for all tool executions, in milliseconds.
   * Individual tools override this via `ToolDescriptor.timeout`.
   * @default 10_000
   */
  defaultTimeoutMs?: number;
  /**
   * Fallback retry policy applied when a tool has no `retryPolicy` of its own.
   * Merged field-by-field on top of the SDK default (maxRetries:2, backoffMs:1000, …).
   */
  defaultRetryPolicy?: Partial<RetryPolicy>;
  /**
   * Observer for content provenance. When present, it is told about results
   * flagged `untrusted` and about side-effecting tools running afterwards.
   *
   * Purely observational: it can emit events but never alters execution.
   */
  untrustedTracker?: UntrustedTracker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether `err` qualifies for a retry attempt given the active policy.
 * When `retryableErrors` is empty every error is retryable.
 */
function isRetryable(err: unknown, retryableErrors: string[]): boolean {
  if (retryableErrors.length === 0) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return retryableErrors.some((pattern) => msg.includes(pattern));
}

/**
 * Merges an optional tool-level {@link RetryPolicy} on top of the executor default,
 * returning a fully-resolved policy with no optional fields.
 */
function resolvePolicy(base: ResolvedPolicy, override?: RetryPolicy): ResolvedPolicy {
  if (override === undefined) return base;
  return {
    maxRetries: override.maxRetries,
    backoffMs: override.backoffMs,
    backoffMultiplier: override.backoffMultiplier,
    retryableErrors: override.retryableErrors ?? base.retryableErrors,
  };
}

/**
 * Stamps the wall-clock `durationMs` into a {@link ToolResult}, preserving any
 * existing metadata fields (`tokensUsed`, `cached`) returned by the tool.
 *
 * Conditional spreads are required by `exactOptionalPropertyTypes`.
 */
function withDuration(result: ToolResult, durationMs: number): ToolResult {
  const prev = result.metadata;
  const metadata: NonNullable<ToolResult['metadata']> = {
    durationMs,
    ...(prev?.tokensUsed !== undefined && { tokensUsed: prev.tokensUsed }),
    ...(prev?.cached !== undefined && { cached: prev.cached }),
  };

  const out: ToolResult = { success: result.success, metadata };
  if (result.data !== undefined) out.data = result.data;
  if (result.error !== undefined) out.error = result.error;
  // Preserve provenance passages: per the ToolResult contract these are surfaced
  // to event subscribers (e.g. RAG source citations) and must survive the
  // duration-stamping rebuild.
  if (result.passages !== undefined) out.passages = result.passages;
  // Same reasoning for the untrusted marker: dropping it here would hand
  // downstream middleware and the host a result that looks trustworthy.
  if (result.untrusted !== undefined) out.untrusted = result.untrusted;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolExecutor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes tools registered in a {@link ToolRegistry} with full production-grade
 * guards:
 *
 * 1. **Resolve** — looks up the tool by name; throws {@link ToolNotFoundError} if absent.
 * 2. **Validate** — compiles and runs the tool's `inputSchema` with AJV; returns a
 *    failed {@link ToolResult} on schema errors (does not throw).
 * 3. **Timeout** — races the tool's promise against a `setTimeout`; resolves to
 *    a failed result if the deadline is exceeded.
 * 4. **Retry** — on thrown errors, retries up to `maxRetries` times using
 *    exponential-backoff delays, filtered by `retryableErrors` substrings.
 * 5. **Events** — emits `tool.call.start`, `tool.call.end`, or `tool.call.error`
 *    via {@link EventBus} regardless of outcome.
 *
 * The `execute()` method always resolves to a {@link ToolResult} — it never
 * rejects for tool-level errors. Only programming errors (tool not registered)
 * are surfaced as exceptions.
 *
 * @example
 * ```typescript
 * const executor = new ToolExecutor(registry, eventBus, {
 *   defaultTimeoutMs: 10_000,
 *   defaultRetryPolicy: { maxRetries: 2, backoffMs: 500, backoffMultiplier: 2 },
 * });
 *
 * const result = await executor.execute('finance.getBalance', { accountId: '1001' }, ctx);
 * if (result.success) console.log(result.data);
 * ```
 */
export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #bus: EventBus;
  readonly #defaultTimeoutMs: number;
  readonly #defaultRetryPolicy: ResolvedPolicy;

  /** AJV instance used for JSON Schema validation. */
  readonly #ajv = new Ajv({ allErrors: true });

  /** Compiled validators cached by tool name to avoid re-compilation per call. */
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #untrusted: UntrustedTracker | undefined;

  constructor(registry: ToolRegistry, eventBus: EventBus, options: ToolExecutorOptions = {}) {
    this.#registry = registry;
    this.#bus = eventBus;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const custom = options.defaultRetryPolicy ?? {};
    this.#defaultRetryPolicy = {
      maxRetries: custom.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
      backoffMs: custom.backoffMs ?? DEFAULT_RETRY_POLICY.backoffMs,
      backoffMultiplier: custom.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier,
      retryableErrors: custom.retryableErrors ?? DEFAULT_RETRY_POLICY.retryableErrors,
    };

    this.#untrusted = options.untrustedTracker;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Executes a tool by name.
   *
   * @param toolName - Must match a name registered in the {@link ToolRegistry}.
   * @param input    - Arbitrary payload validated against the tool's `inputSchema`.
   * @param context  - Execution context forwarded to the tool's `execute()` method.
   * @returns A resolved {@link ToolResult}. Never rejects for tool-level errors.
   * @throws {@link ToolNotFoundError} if `toolName` is not in the registry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(toolName: string, input: any, context: ExecutionContext): Promise<ToolResult> {
    // Step 1 — Resolve
    const tool = this.#registry.get(toolName);
    if (tool === undefined) {
      throw new ToolNotFoundError(toolName);
    }

    // Step 2 — Emit start
    this.#bus.emit('tool.call.start', { toolName, input });
    const startedAt = Date.now();

    // Step 3 — Validate input
    const validate = this.#getValidator(toolName, tool.inputSchema);
    if (!validate(input)) {
      const msg = `Input validation failed: ${this.#ajv.errorsText(validate.errors)}`;
      this.#bus.emit('tool.call.error', { toolName, error: msg });
      return { success: false, error: msg, metadata: { durationMs: Date.now() - startedAt } };
    }

    // Step 3.bis — Note an outlet running in a turn that already took in
    // untrusted content. Observational only: nothing is blocked by it.
    if (tool.sideEffects === true) {
      this.#untrusted?.noteSideEffect(context, toolName);
    }

    // Step 4 — Execute with retry + timeout
    const policy = resolvePolicy(this.#defaultRetryPolicy, tool.retryPolicy);
    const timeoutMs = tool.timeout ?? this.#defaultTimeoutMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
      try {
        const result = await this.#runWithTimeout(tool, input, context, toolName, timeoutMs);
        const durationMs = Date.now() - startedAt;
        // Step 5 — Emit end (success or application-level failure)
        this.#untrusted?.record(context, toolName, result);
        this.#bus.emit('tool.call.end', { toolName, success: result.success, durationMs });
        return withDuration(result, durationMs);
      } catch (err) {
        lastError = err;
        const hasMore = attempt <= policy.maxRetries;
        if (hasMore && isRetryable(err, policy.retryableErrors)) {
          const delay = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1);
          await sleep(delay);
        } else {
          break;
        }
      }
    }

    // All attempts exhausted
    const durationMs = Date.now() - startedAt;
    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
    this.#bus.emit('tool.call.error', { toolName, error: errorMsg });
    return { success: false, error: errorMsg, metadata: { durationMs } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Races the tool's `execute()` promise against a deadline timer.
   * The timer is always cleaned up in the `finally` block.
   *
   * @throws {@link ToolTimeoutError} if the deadline is exceeded.
   */
  async #runWithTimeout(
    tool: Tool,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    context: ExecutionContext,
    toolName: string,
    timeoutMs: number,
  ): Promise<ToolResult> {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new ToolTimeoutError(toolName, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([tool.execute(input, context), deadline]);
    } finally {
      clearTimeout(timerId);
    }
  }

  /**
   * Returns a compiled AJV {@link ValidateFunction} for the given tool,
   * compiling and caching it on first call.
   */
  #getValidator(toolName: string, schema: JSONSchema): ValidateFunction {
    let validate = this.#validators.get(toolName);
    if (validate === undefined) {
      validate = this.#ajv.compile(schema);
      this.#validators.set(toolName, validate);
    }
    return validate;
  }
}
