import type { ExecutionContext } from '../../types/index.js';
import type { SecurityMiddleware, MiddlewarePayload, MiddlewareResult } from '../types.js';
import type { RateLimiter } from '../RateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// RateLimiterMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-phase middleware that enforces per-tenant and per-user rate limits.
 *
 * Runs on every `agent_start` payload (before any processing occurs) and
 * consumes one slot for both the tenant and the user in the `minute` window.
 * If either limit is exceeded the chain is blocked immediately.
 *
 * Key formats forwarded to {@link RateLimiter.check}:
 * - Tenant: `'tenant:<tenantId>'`
 * - User:   `'user:<tenantId>:<userId>'`
 *
 * **Priority:** `10` (first middleware in the pre chain).
 */
export class RateLimiterMiddleware implements SecurityMiddleware {
  readonly name = 'rate_limiter';
  readonly phase = 'pre' as const;
  readonly priority = 10;
  readonly appliesTo = 'agent' as const;

  readonly #limiter: RateLimiter;

  /**
   * @param limiter - Configured rate limiter instance.
   */
  constructor(limiter: RateLimiter) {
    this.#limiter = limiter;
  }

  /**
   * Checks per-tenant then per-user minute-window limits.
   *
   * @param context - Execution context providing `tenantId` and `userId`.
   * @param payload - Must be `type: 'agent_start'` to trigger checks.
   * @returns `block` if either limit is exceeded; `continue` otherwise.
   */
  async execute(context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult> {
    if (payload.type !== 'agent_start') {
      return { action: 'continue' };
    }

    const tenantKey = `tenant:${context.tenantId}`;
    const tenantResult = await this.#limiter.check(tenantKey, 'minute');
    if (!tenantResult.allowed) {
      return {
        action: 'block',
        reason: `Tenant rate limit exceeded. Resets at ${tenantResult.resetAt.toISOString()}`,
        events: [
          {
            type: 'security.ratelimit.hit',
            data: {
              key: tenantKey,
              scope: 'tenant',
              limit: tenantResult.limit,
              resetAt: tenantResult.resetAt.toISOString(),
            },
          },
        ],
      };
    }

    const userKey = `user:${context.tenantId}:${context.userId}`;
    const userResult = await this.#limiter.check(userKey, 'minute');
    if (!userResult.allowed) {
      return {
        action: 'block',
        reason: `User rate limit exceeded. Resets at ${userResult.resetAt.toISOString()}`,
        events: [
          {
            type: 'security.ratelimit.hit',
            data: {
              key: userKey,
              scope: 'user',
              limit: userResult.limit,
              resetAt: userResult.resetAt.toISOString(),
            },
          },
        ],
      };
    }

    return { action: 'continue' };
  }
}
