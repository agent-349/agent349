import type { ExecutionContext } from '../../types/index.js';
import type {
  SecurityMiddleware,
  MiddlewarePayload,
  MiddlewareResult,
  SecurityMiddlewareEvent,
} from '../types.js';
import type { EventBus } from '../../events/EventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the set of `appliesTo` values that match a given payload type.
 * A middleware whose `appliesTo` is in this set will run for the payload.
 */
function appliesToValues(
  payloadType: MiddlewarePayload['type'],
): Set<SecurityMiddleware['appliesTo']> {
  switch (payloadType) {
    case 'agent_start':
    case 'agent_response':
      return new Set(['agent', 'all']);
    case 'tool_call':
    case 'tool_result':
      return new Set(['tool', 'all']);
    case 'rag_query':
    case 'rag_result':
      return new Set(['rag', 'all']);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SecurityMiddlewareChain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered pipeline of {@link SecurityMiddleware} instances executed before
 * (`pre`) or after (`post`) every agent/tool/RAG operation.
 *
 * ### Execution rules
 *
 * 1. Middlewares in the active phase are sorted by **ascending `priority`**
 *    (lower number = runs first).
 * 2. Only middlewares whose `appliesTo` matches the payload type run:
 *    - `'agent'` → `agent_start`, `agent_response`
 *    - `'tool'`  → `tool_call`, `tool_result`
 *    - `'rag'`   → `rag_query`, `rag_result`
 *    - `'all'`   → all payload types
 * 3. If a middleware returns `action: 'block'`, the chain **stops immediately**
 *    and propagates the block decision (subsequent middlewares do not run).
 * 4. If a middleware returns `action: 'modify'`, its `modifiedPayload` (the
 *    updated full {@link MiddlewarePayload}) is forwarded to subsequent
 *    middlewares as the new current payload.
 * 5. If all middlewares pass, the chain returns `action: 'continue'`, or
 *    `action: 'modify'` carrying the final payload if any middleware modified it.
 *
 * ### modifiedPayload convention
 *
 * When a middleware returns `action: 'modify'`, its `modifiedPayload` **must**
 * be the complete updated {@link MiddlewarePayload} (not just the changed field).
 * The chain propagates this full payload to the next middleware and, at the end,
 * returns it as the chain-level `modifiedPayload`.
 *
 * @example
 * ```typescript
 * const chain = new SecurityMiddlewareChain();
 * chain.use(new ToolACLMiddleware(aclService));
 * chain.use(new FieldMaskMiddleware(fieldMasker));
 *
 * const result = await chain.executePost(context, {
 *   type: 'tool_result', toolName: 'hr.getEmployee', output: rawData,
 * });
 * if (result.action === 'block') throw new AccessDeniedError(result.reason!);
 * if (result.action === 'modify') {
 *   const updated = result.modifiedPayload as MiddlewarePayload;
 *   filteredData = updated.output;
 * }
 * ```
 */
export class SecurityMiddlewareChain {
  readonly #middlewares: SecurityMiddleware[] = [];
  readonly #bus: EventBus | undefined;

  /**
   * @param eventBus - Optional EventBus. When provided, security observability
   *   events reported by middlewares (`security.acl.denied`,
   *   `security.injection.detected`, `security.ratelimit.hit`,
   *   `security.field.masked`) are emitted, enriched with the request's
   *   `_context`. Pass `orchestrator.events` to feed the audit/logging planes.
   */
  constructor(eventBus?: EventBus) {
    this.#bus = eventBus;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a middleware in the chain.
   * Middlewares are sorted by priority at execution time, so registration order
   * does not determine execution order.
   *
   * @param middleware - The middleware to add.
   */
  use(middleware: SecurityMiddleware): void {
    this.#middlewares.push(middleware);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs all registered `pre`-phase middlewares that apply to `payload.type`,
   * in ascending priority order.
   *
   * @param context - Immutable execution context for the current request.
   * @param payload - Data describing the current pipeline stage.
   * @returns The aggregated chain decision.
   */
  async executePre(
    context: ExecutionContext,
    payload: MiddlewarePayload,
  ): Promise<MiddlewareResult> {
    return this.#run('pre', context, payload);
  }

  /**
   * Runs all registered `post`-phase middlewares that apply to `payload.type`,
   * in ascending priority order.
   *
   * @param context - Immutable execution context for the current request.
   * @param payload - Data describing the current pipeline stage.
   * @returns The aggregated chain decision.
   */
  async executePost(
    context: ExecutionContext,
    payload: MiddlewarePayload,
  ): Promise<MiddlewareResult> {
    return this.#run('post', context, payload);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async #run(
    phase: 'pre' | 'post',
    context: ExecutionContext,
    initialPayload: MiddlewarePayload,
  ): Promise<MiddlewareResult> {
    const applicable = appliesToValues(initialPayload.type);

    const ordered = this.#middlewares
      .filter((m) => m.phase === phase && applicable.has(m.appliesTo))
      .sort((a, b) => a.priority - b.priority);

    let currentPayload = initialPayload;
    let modified = false;

    for (const middleware of ordered) {
      const result = await middleware.execute(context, currentPayload);

      // Emit any observability events the middleware reported, regardless of
      // its action (e.g. a masked-field event accompanies a 'modify').
      if (result.events !== undefined) this.#emitEvents(context, result.events);

      if (result.action === 'block') {
        return { action: 'block', ...(result.reason !== undefined && { reason: result.reason }) };
      }

      if (result.action === 'modify' && result.modifiedPayload !== undefined) {
        // The middleware returns the full updated MiddlewarePayload
        currentPayload = result.modifiedPayload as MiddlewarePayload;
        modified = true;
      }
    }

    if (modified) {
      return { action: 'modify', modifiedPayload: currentPayload };
    }

    return { action: 'continue' };
  }

  /**
   * Emits each middleware-reported event on the bus, enriched with the request's
   * `_context` so the audit/logging collectors can correlate it. No-op when no
   * bus was configured.
   */
  #emitEvents(context: ExecutionContext, events: SecurityMiddlewareEvent[]): void {
    if (this.#bus === undefined) return;
    const _context = {
      tenantId: context.tenantId,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      requestId: context.requestId,
    };
    for (const event of events) {
      this.#bus.emit(event.type, { ...event.data, _context });
    }
  }
}
