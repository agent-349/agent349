import type { ExecutionContext } from '../../types/index.js';
import type { SecurityMiddleware, MiddlewarePayload, MiddlewareResult } from '../types.js';
import type { ACLService } from '../ACLService.js';

// ─────────────────────────────────────────────────────────────────────────────
// ToolACLMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-phase middleware that enforces tool-level access control (Nivel 1).
 *
 * Runs before every `tool_call` and consults the {@link ACLService} to decide
 * whether the user in `context` is allowed to invoke the named tool. If the
 * ACL evaluation denies access the chain is blocked immediately and the tool
 * never executes.
 *
 * Non-`tool_call` payloads are passed through with `action: 'continue'`.
 *
 * **Priority:** `30` (runs after `RateLimiterMiddleware` at 10 and
 * `InputSanitizerMiddleware` at 20).
 */
export class ToolACLMiddleware implements SecurityMiddleware {
  readonly name = 'tool_acl';
  readonly phase = 'pre' as const;
  readonly priority = 30;
  readonly appliesTo = 'tool' as const;

  readonly #acl: ACLService;

  /**
   * @param aclService - Configured ACL service holding the tool policies.
   */
  constructor(aclService: ACLService) {
    this.#acl = aclService;
  }

  /**
   * Evaluates whether the user may call the tool specified in `payload.toolName`.
   *
   * @param context - Execution context providing the user's roles.
   * @param payload - Must be `type: 'tool_call'` to trigger evaluation.
   * @returns `block` with the denial reason if access is denied; `continue` otherwise.
   */
  async execute(context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult> {
    if (payload.type !== 'tool_call' || payload.toolName === undefined) {
      return { action: 'continue' };
    }

    const decision = this.#acl.evaluate('tool', payload.toolName, context);

    if (!decision.allowed) {
      return {
        action: 'block',
        ...(decision.reason !== undefined && { reason: decision.reason }),
        events: [
          {
            type: 'security.acl.denied',
            data: {
              toolName: payload.toolName,
              reason: decision.reason ?? 'access denied',
              decision,
            },
          },
        ],
      };
    }

    return { action: 'continue' };
  }
}
