import type { ExecutionContext } from '../../types/index.js';
import type { SecurityMiddleware, MiddlewarePayload, MiddlewareResult } from '../types.js';
import type { InputSanitizer } from '../InputSanitizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// InputSanitizerMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-phase middleware that detects and neutralises prompt injection in
 * user-supplied messages.
 *
 * Runs on `agent_start` payloads and delegates to {@link InputSanitizer} to
 * analyse the `payload.message` field. Based on the analysis:
 *
 * - `riskLevel: 'high'` (recommendation `'block'`) → chain is stopped immediately.
 * - `riskLevel: 'medium'` (recommendation `'sanitize'`) → the message is
 *   sanitised and forwarded as a modified payload.
 * - `riskLevel: 'none'` / `'low'` (recommendation `'allow'`) → chain continues.
 *
 * Non-`agent_start` payloads are passed through with `action: 'continue'`.
 *
 * **Priority:** `20` (runs after `RateLimiterMiddleware` at 10 and before
 * `ToolACLMiddleware` at 30).
 */
export class InputSanitizerMiddleware implements SecurityMiddleware {
  readonly name = 'input_sanitizer';
  readonly phase = 'pre' as const;
  readonly priority = 20;
  readonly appliesTo = 'agent' as const;

  readonly #sanitizer: InputSanitizer;

  /**
   * @param sanitizer - Configured input sanitiser.
   */
  constructor(sanitizer: InputSanitizer) {
    this.#sanitizer = sanitizer;
  }

  /**
   * Analyses `payload.message` for injection patterns.
   *
   * @param context - Immutable execution context (used for logging; not mutated).
   * @param payload - Must be `type: 'agent_start'` to trigger analysis.
   * @returns `block`, `modify` (sanitised message), or `continue`.
   */
  async execute(_context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult> {
    if (payload.type !== 'agent_start' || payload.message === undefined) {
      return { action: 'continue' };
    }

    const result = this.#sanitizer.analyze(payload.message);

    if (result.recommendation === 'block') {
      return {
        action: 'block',
        reason:
          `Prompt injection detected (risk: ${result.riskLevel}). ` +
          `Patterns: ${result.patterns.map((p) => p.type).join(', ')}`,
        events: [
          {
            type: 'security.injection.detected',
            data: { action: 'block', riskLevel: result.riskLevel, patterns: result.patterns },
          },
        ],
      };
    }

    if (result.recommendation === 'sanitize') {
      const sanitized = this.#sanitizer.sanitize(payload.message);
      return {
        action: 'modify',
        modifiedPayload: { ...payload, message: sanitized } satisfies MiddlewarePayload,
        events: [
          {
            type: 'security.injection.detected',
            data: { action: 'sanitize', riskLevel: result.riskLevel, patterns: result.patterns },
          },
        ],
      };
    }

    return { action: 'continue' };
  }
}
