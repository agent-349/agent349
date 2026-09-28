import type { ExecutionContext } from '../../types/index.js';
import type { SecurityMiddleware, MiddlewarePayload, MiddlewareResult } from '../types.js';
import type { FieldMasker } from '../FieldMasker.js';

// ─────────────────────────────────────────────────────────────────────────────
// FieldMaskMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-phase middleware that masks sensitive fields in tool results (Nivel 3).
 *
 * Runs after every `tool_result` and delegates to {@link FieldMasker} to
 * replace or obscure fields that the user's roles do not permit them to see.
 * The masked output is returned as a modified payload so the LLM only receives
 * data appropriate for the user's authorisation level.
 *
 * Non-`tool_result` payloads are passed through with `action: 'continue'`.
 *
 * **Priority:** `50` (last in the post chain; runs after {@link DataFilterMiddleware}
 * at 40 so it masks an already-filtered result set).
 */
export class FieldMaskMiddleware implements SecurityMiddleware {
  readonly name = 'field_mask';
  readonly phase = 'post' as const;
  readonly priority = 50;
  readonly appliesTo = 'tool' as const;

  readonly #masker: FieldMasker;

  /**
   * @param fieldMasker - Configured field masker holding the mask rules.
   */
  constructor(fieldMasker: FieldMasker) {
    this.#masker = fieldMasker;
  }

  /**
   * Masks sensitive fields in `payload.output` for the tool identified by
   * `payload.toolName`.
   *
   * @param context - Execution context providing the user's roles.
   * @param payload - Must be `type: 'tool_result'` to trigger masking.
   * @returns `modify` with the masked payload, or `continue` if no rules apply.
   */
  async execute(context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult> {
    if (payload.type !== 'tool_result' || payload.toolName === undefined) {
      return { action: 'continue' };
    }

    const masked = this.#masker.mask(payload.toolName, payload.output, context);

    // FieldMasker always returns a structuredClone when rules apply; if no
    // rules matched it returns the original reference unchanged.
    if (masked === payload.output) {
      return { action: 'continue' };
    }

    return {
      action: 'modify',
      modifiedPayload: { ...payload, output: masked } satisfies MiddlewarePayload,
      events: [
        {
          type: 'security.field.masked',
          data: {
            toolName: payload.toolName,
            fields: this.#masker.ruleFieldsFor(payload.toolName),
          },
        },
      ],
    };
  }
}
