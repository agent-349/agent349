import type { ExecutionContext } from '../../types/index.js';
import type { SecurityMiddleware, MiddlewarePayload, MiddlewareResult } from '../types.js';
import type { DataFilter } from '../DataFilter.js';

// ─────────────────────────────────────────────────────────────────────────────
// DataFilterMiddleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-phase middleware that applies data-level filtering to tool results (Nivel 2).
 *
 * Runs after every `tool_result` and delegates to {@link DataFilter} to remove
 * records the user is not authorised to see (e.g. wrong tenant or lacking the
 * required `accessRoles`). The filtered output is returned as a modified payload
 * so that subsequent post-phase middlewares (e.g. {@link FieldMaskMiddleware})
 * receive the already-filtered data.
 *
 * Non-`tool_result` payloads are passed through with `action: 'continue'`.
 *
 * **Priority:** `40` (runs after `ToolACLMiddleware` at 30 and before
 * `FieldMaskMiddleware` at 50).
 */
export class DataFilterMiddleware implements SecurityMiddleware {
  readonly name = 'data_filter';
  readonly phase = 'post' as const;
  readonly priority = 40;
  readonly appliesTo = 'tool' as const;

  readonly #dataFilter: DataFilter;

  /**
   * @param dataFilter - Configured data filter holding the filter rules.
   */
  constructor(dataFilter: DataFilter) {
    this.#dataFilter = dataFilter;
  }

  /**
   * Filters `payload.output` for the tool identified by `payload.toolName`.
   *
   * @param context - Execution context providing the user's `tenantId` and `roles`.
   * @param payload - Must be `type: 'tool_result'` to trigger filtering.
   * @returns `modify` with the filtered payload, or `continue` if no change.
   */
  async execute(context: ExecutionContext, payload: MiddlewarePayload): Promise<MiddlewareResult> {
    if (payload.type !== 'tool_result' || payload.toolName === undefined) {
      return { action: 'continue' };
    }

    const filtered = this.#dataFilter.filter(payload.toolName, payload.output, context);

    // Only signal modify if the reference actually changed (filter applied something)
    if (filtered === payload.output) {
      return { action: 'continue' };
    }

    return {
      action: 'modify',
      modifiedPayload: { ...payload, output: filtered } satisfies MiddlewarePayload,
    };
  }
}
